# Telegram Dubai Unit Finder Bot

Workflow:

Telegram link message → scrape Bayut listing → extract permit/details → optional Trakheesi/DLD resolver → reply with unit/property number.

## Step 1: Create Telegram bot

1. Open Telegram.
2. Search `@BotFather`.
3. Send `/newbot`.
4. Copy the bot token.

## Step 2: Install

```bash
npm install
cp .env.example .env
```

Open `.env` and paste your BotFather token:

```env
TELEGRAM_BOT_TOKEN=123456789:ABC...
```

## Step 3: Run

```bash
npm start
```

Send a Bayut listing link to your bot.

## What works now

- Accepts Bayut listing links.
- Extracts listing ID, permit number, project/building/area, rooms, size, price, reference.
- Replies in Telegram.
- Does not store user history or searches.

## What needs to be connected next

The exact unit/property number requires a resolver:

Permit number → Trakheesi/DLD broker access → Unit number / property number / land number.

Add your resolver URL in `.env`:

```env
RESOLVER_API_URL=https://your-secure-resolver.com/find-unit
```

Do not hard-code your Trakheesi password in this bot.
