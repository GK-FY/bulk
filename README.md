# FY'S PROPERTY WhatsApp Bot

A fully featured WhatsApp automation bot with **admin dashboard**, **configurable settings via WhatsApp & Web**, **M-PESA integration**, and **multi-platform deployment support**.

---

## 🚀 Key Features

### For Users
- **Simple Registration** - Just send your username to get started
- **Numbered Menu System** - Easy navigation with clear options (1-8)
- **Bulk Messaging** - Send broadcasts to all your recipients
- **M-PESA Top-up** - Instant balance loading via STK Push
- **Balance Tracking** - Real-time balance and usage stats
- **24/7 Support** - Built-in support contact system

### For Admins
- **Full Dashboard** - Web-based admin panel
- **WhatsApp Admin Controls** - Manage everything from WhatsApp
- **Editable Bot Settings** - Change bot name, texts, and messages
- **User Management** - View, ban/unban, modify balances
- **Broadcast System** - Message all users at once
- **Transaction Tracking** - View all deposits and payments

---

## 📱 User Menu (Numbered Options)

```
1️⃣ Send Bulk Message - Broadcast to all recipients
2️⃣ View Recipients - See your contact list
3️⃣ Add Recipient - Add new contacts
4️⃣ Remove Recipient - Remove contacts
5️⃣ Top-up Balance - M-PESA deposit
6️⃣ Check Balance - View account summary
7️⃣ Contact Support - Get help
8️⃣ Delete Account - Remove your account
```

---

## 🛡️ Admin Panel (WhatsApp Commands)

```
USER MANAGEMENT
1️⃣  View All Users
2️⃣  Change Cost/Char
3️⃣  Modify User Balance
4️⃣  Ban/Unban User

COMMUNICATIONS
5️⃣  Broadcast to All

ADMIN MANAGEMENT
6️⃣  Add Admin
7️⃣  Remove Admin

SYSTEM
8️⃣  View Dashboard URL
9️⃣  Recent Transactions

BOT SETTINGS (Editable!)
10  Edit Bot Name
11  Edit Welcome Text
12  Edit Support Text
13  Edit Topup Prompt
14  Edit Registration Message
15  Edit Low Balance Message
16  View All Settings
```

---

## 🌐 Admin Dashboard Features

Access the web dashboard to:
- View QR code for WhatsApp connection
- Monitor bot status and statistics
- Manage all bot settings
- View and manage users
- Send broadcasts
- View transaction history

---

## 🔧 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SHADOW_API_KEY` | Shadow Payment Gateway API Key | Yes |
| `SHADOW_API_SECRET` | Shadow Payment Gateway API Secret | Yes |
| `SHADOW_ACCOUNT_ID` | Your Shadow Payment Account ID | Yes |
| `SUPER_ADMIN` | Super Admin WhatsApp number (e.g., 254712345678) | Yes |
| `ADMIN_LABEL` | Admin label shown in broadcasts | No |
| `PORT` | Server port (default: 5000) | No |
| `NODE_ENV` | Environment (production/development) | No |

---

## 🚀 Deployment Guides

### Deploy to Heroku

1. **Create Heroku app**
   ```bash
   heroku create your-bot-name
   ```

2. **Add Buildpacks** (required for Chromium)
   ```bash
   heroku buildpacks:add heroku/nodejs
   heroku buildpacks:add https://github.com/jontewks/puppeteer-heroku-buildpack
   ```

3. **Add Postgres**
   ```bash
   heroku addons:create heroku-postgresql:essential-0
   ```

4. **Set environment variables**
   ```bash
   heroku config:set SHADOW_API_KEY=your_api_key
   heroku config:set SHADOW_API_SECRET=your_api_secret
   heroku config:set SHADOW_ACCOUNT_ID=your_account_id
   heroku config:set SUPER_ADMIN=254712345678
   heroku config:set NODE_ENV=production
   heroku config:set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
   heroku config:set PUPPETEER_EXECUTABLE_PATH=/app/.apt/usr/bin/google-chrome
   ```

5. **Deploy**
   ```bash
   git push heroku main
   ```

6. **Prevent sleeping** - Use a service like UptimeRobot to ping `/health` every 5 minutes

**Important:** Heroku has an ephemeral filesystem, meaning the WhatsApp session will be lost when the dyno restarts (typically every 24 hours or after deploying). You will need to re-scan the QR code after each restart. To avoid this, consider using a platform with persistent storage or upgrading to Heroku's paid plans with longer uptime

---

### Deploy to Render

1. **Connect your repository** on [render.com](https://render.com)
2. **The `render.yaml` file** will auto-configure everything
3. **Add environment variables** in the Render dashboard
4. **Deploy** - Render handles the rest!

---

### Deploy to Railway

1. **Connect your repository** on [railway.app](https://railway.app)
2. **Add PostgreSQL** database from Railway's marketplace
3. **Set environment variables**:
   - `SHADOW_API_KEY`
   - `SHADOW_API_SECRET`
   - `SHADOW_ACCOUNT_ID`
   - `SUPER_ADMIN`
4. **Deploy** - Railway auto-detects and builds

---

### Deploy to Koyeb

1. **Create new app** on [koyeb.com](https://koyeb.com)
2. **Connect your GitHub repository**
3. **Add secrets**:
   - `shadow-api-key`
   - `shadow-api-secret`
   - `shadow-account-id`
   - `super-admin`
   - `database-url`
4. **Set port** to 5000
5. **Deploy**

---

### Deploy with Docker

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-repo/fys-property-bot.git
   cd fys-property-bot
   ```

2. **Create `.env` file**
   ```env
   SHADOW_API_KEY=your_api_key
   SHADOW_API_SECRET=your_api_secret
   SHADOW_ACCOUNT_ID=your_account_id
   SUPER_ADMIN=254712345678
   ADMIN_LABEL=Admin
   ```

3. **Run with Docker Compose**
   ```bash
   docker-compose up -d
   ```

---

## 🔄 Keep-Alive Mechanism

The bot includes a built-in keep-alive system that:
- Pings itself every 4 minutes
- Prevents sleeping on free-tier hosting
- Exposes `/health` and `/keep-alive` endpoints

For extra reliability, use an external service like:
- [UptimeRobot](https://uptimerobot.com) (free)
- [Cron-Job.org](https://cron-job.org) (free)

Configure to ping your bot's `/health` endpoint every 5 minutes.

---

## 📋 Editing Bot Settings

### Via WhatsApp (Admin)
1. Type any message to see admin menu
2. Select option `10-15` to edit settings
3. Send your new text
4. Changes apply immediately!

### Via Dashboard
1. Open your bot's URL in a browser
2. Click "Bot Settings" tab
3. Edit any field
4. Click "Save All"

### Editable Settings
- **Bot Name** - Displayed throughout the bot
- **Admin Label** - Name shown in broadcasts
- **Cost Per Character** - Charge per broadcast character
- **Welcome Text** - Message for new users
- **Support Text** - Contact support message
- **Top-up Prompt** - Balance top-up message
- **Registration Success** - After user registers
- **Low Balance Message** - When balance is insufficient

---

## 🗄️ Database

The bot uses PostgreSQL for:
- **Transactions** - All M-PESA payments
- **Bot Settings** - Configurable texts and values
- **Admin Users** - Additional admin phone numbers

User data is stored in `users.json` for quick access.

---

## 📄 License

MIT © FY'S PROPERTY

---

## ❤️ Contributing

Pull requests, issues, and suggestions are welcome!
