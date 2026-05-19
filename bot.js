import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Telegraf } from 'telegraf';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RESOLVER_API_URL = process.env.RESOLVER_API_URL;
const RESOLVER_API_KEY = process.env.RESOLVER_API_KEY;

if (!BOT_TOKEN) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
}

const bot = new Telegraf(BOT_TOKEN);

function extractUrl(text) {
    const match = String(text || '').match(/https?:\/\/[^\s]+/i);
    return match ? match[0].trim() : null;
}

function getListingId(url) {
    const match = String(url).match(/details-(\d+)\.html/i);
    return match ? match[1] : null;
}

function cleanNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    const n = Number(String(value).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function deepFind(obj, predicate, results = []) {
    if (!obj || typeof obj !== 'object') return results;

    try {
        if (predicate(obj)) results.push(obj);
    } catch {}

    if (Array.isArray(obj)) {
        for (const item of obj) deepFind(item, predicate, results);
    } else {
        for (const key of Object.keys(obj)) deepFind(obj[key], predicate, results);
    }

    return results;
}

function findPropertyDetails(nextData) {
    const possible = [];

    try {
        const queries = nextData?.props?.pageProps?.queries || [];
        for (const q of queries) {
            const data = q?.state?.data;
            if (data?.propertyDetails) possible.push(data.propertyDetails);
            if (data?.property) possible.push(data.property);
        }
    } catch {}

    try {
        if (nextData?.props?.pageProps?.propertyDetails) {
            possible.push(nextData.props.pageProps.propertyDetails);
        }
    } catch {}

    const deep = deepFind(nextData, (x) =>
        (x?.permitNumber || x?.permit_number || x?.referenceNumber || x?.reference_number)
        && (x?.area || x?.rooms || x?.price || x?.location)
    );

    possible.push(...deep);
    possible.sort((a, b) => Object.keys(b || {}).length - Object.keys(a || {}).length);

    return possible[0] || null;
}

function locationText(location) {
    if (!Array.isArray(location)) return null;
    return location.map(x => x?.name).filter(Boolean).join(' > ') || null;
}

function lastLocationName(location) {
    if (!Array.isArray(location)) return null;
    const names = location.map(x => x?.name).filter(Boolean);
    return names.length ? names[names.length - 1] : null;
}

function normalizeBayutDetails(url, prop) {
    const location = prop?.location || prop?.locationHierarchy || [];
    const roomsRaw = prop?.rooms ?? prop?.bedrooms ?? prop?.beds ?? null;
    const roomsClean = roomsRaw !== null && roomsRaw !== undefined
        ? String(roomsRaw).replace(/[^0-9]/g, '')
        : null;

    return {
        platform: 'Bayut',
        url,
        listingId: getListingId(url),
        permitNumber: prop?.permitNumber || prop?.permit_number || prop?.permit || null,
        referenceNumber: prop?.referenceNumber || prop?.reference_number || prop?.externalID || null,
        title: prop?.title || prop?.shortTitle || null,
        price: cleanNumber(prop?.price),
        rooms: roomsClean,
        beds: roomsClean ? `${roomsClean}BR` : null,
        baths: prop?.baths || prop?.bathrooms || null,
        sizeSqft: cleanNumber(prop?.area || prop?.size || prop?.plotArea),
        project: prop?.projectName || prop?.project || null,
        building: prop?.buildingName || prop?.building || null,
        area: lastLocationName(location),
        locationPath: locationText(location),
        agency: prop?.agency?.name || prop?.agencyName || null,
        broker: prop?.contactName || prop?.broker?.name || prop?.ownerName || null,
    };
}

async function scrapeBayut(url) {
    const { data: html } = await axios.get(url, {
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });

    const $ = cheerio.load(html);
    const script = $('#__NEXT_DATA__').html();

    if (!script) {
        throw new Error('Bayut page data not found. Bayut may have blocked the request or changed page structure.');
    }

    const nextData = JSON.parse(script);
    const prop = findPropertyDetails(nextData);

    if (!prop) {
        throw new Error('Property details not found inside Bayut page data.');
    }

    return normalizeBayutDetails(url, prop);
}

async function resolveUnit(scraped) {
    if (!RESOLVER_API_URL) {
        return {
            status: 'EXTRACTED_ONLY',
            unitNumber: null,
            propertyNumber: null,
            landNumber: null,
            landSubNumber: null,
            confidenceScore: 0,
            notes: 'Permit/details extracted. Trakheesi/DLD resolver is not connected yet.',
        };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (RESOLVER_API_KEY) headers['Authorization'] = `Bearer ${RESOLVER_API_KEY}`;

    const payload = {
        permitNumber: scraped.permitNumber,
        listingUrl: scraped.url,
        listingId: scraped.listingId,
        referenceNumber: scraped.referenceNumber,
        project: scraped.project,
        building: scraped.building,
        area: scraped.area,
        rooms: scraped.rooms,
        beds: scraped.beds,
        sizeSqft: scraped.sizeSqft,
        price: scraped.price,
    };

    const { data } = await axios.post(RESOLVER_API_URL, payload, {
        timeout: 45000,
        headers,
    });

    return {
        status: data.status || 'FOUND',
        unitNumber: data.unit_number || data.unitNumber || null,
        propertyNumber: data.property_number || data.propertyNumber || null,
        landNumber: data.land_number || data.landNumber || null,
        landSubNumber: data.land_sub_number || data.landSubNumber || null,
        confidenceScore: data.confidence_score ?? data.confidenceScore ?? 100,
        notes: data.match_notes || data.notes || 'Resolved via Trakheesi/DLD resolver.',
    };
}

function formatReply(scraped, result) {
    if (result.status === 'EXTRACTED_ONLY') {
        return [
            '✅ Listing extracted',
            '',
            `Platform: ${scraped.platform || '-'}`,
            `Listing ID: ${scraped.listingId || '-'}`,
            `Permit No: ${scraped.permitNumber || '-'}`,
            `Reference: ${scraped.referenceNumber || '-'}`,
            '',
            `Project: ${scraped.project || '-'}`,
            `Building: ${scraped.building || '-'}`,
            `Area: ${scraped.area || '-'}`,
            `Rooms: ${scraped.beds || '-'}`,
            `Size: ${scraped.sizeSqft ? `${scraped.sizeSqft} sqft` : '-'}`,
            '',
            '⚠️ Unit resolver not connected yet.',
            'Next: connect Trakheesi/DLD resolver endpoint.',
        ].join('\n');
    }

    const icon = result.status === 'FOUND' ? '✅' : result.status === 'AMBIGUOUS' ? '⚠️' : '❌';

    return [
        `${icon} Unit Finder Result`,
        '',
        `Status: ${result.status}`,
        `Confidence: ${result.confidenceScore ?? 0}%`,
        '',
        `Project: ${scraped.project || '-'}`,
        `Area: ${scraped.area || '-'}`,
        `Permit No: ${scraped.permitNumber || '-'}`,
        '',
        `Unit Number: ${result.unitNumber || '-'}`,
        `Property Number: ${result.propertyNumber || '-'}`,
        `Land Number: ${result.landNumber || '-'}`,
        `Land Sub No: ${result.landSubNumber || '-'}`,
        '',
        `Notes: ${result.notes || '-'}`,
    ].join('\n');
}

bot.start((ctx) => {
    ctx.reply(
        [
            'Send me a Bayut listing link.',
            '',
            'Example:',
            'https://www.bayut.com/property/details-15241815.html',
        ].join('\n')
    );
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const url = extractUrl(text);

    if (!url) {
        await ctx.reply('Send a Bayut listing URL.');
        return;
    }

    if (!url.includes('bayut.com/property/details-')) {
        await ctx.reply('For first version, send a Bayut property details link only.');
        return;
    }

    const loading = await ctx.reply('Checking listing...');

    try {
        const scraped = await scrapeBayut(url);
        const result = await resolveUnit(scraped);
        await ctx.reply(formatReply(scraped, result));
    } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

bot.catch((err) => {
    console.error('Bot error:', err);
});

bot.launch();

console.log('Telegram Unit Finder Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
