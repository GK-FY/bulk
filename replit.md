# FY'S PROPERTY WhatsApp Bot - Premium Edition

## Overview
A premium WhatsApp Bot integrated with Shadow Payment Gateway for M-PESA transactions. Features a beautiful admin dashboard, fully configurable bot settings via WhatsApp & Dashboard, and multi-platform deployment support.

## Recent Changes
- **2024-12-16**: QR Code Display & API Key Generation Fixes
  - **Heroku QR Code Fix**: Enhanced Chromium path detection to support multiple environment variables (PUPPETEER_EXECUTABLE_PATH, GOOGLE_CHROME_BIN, CHROMIUM_PATH, CHROME_BIN)
  - **Auto QR Refresh**: Dashboard now polls `/api/qr` every 3 seconds when not connected, automatically updating the QR code display
  - **Spinner Loading State**: Added visual spinner while waiting for QR code generation
  - **Database Retry Logic**: Added up to 3 retry attempts with 5-second delays for database connection
  - **Better Error Messages**: API key generation now shows specific error messages for missing DATABASE_URL vs connection failures
  - **New API Endpoint**: `/api/qr` returns QR code as base64 data URL for easy integration
  - **app.json Updated**: Added GOOGLE_CHROME_BIN env var for Heroku buildpack compatibility

- **2024-12-15**: Deployment Fixes & Auto Base URL Detection
  - **Fixed npm lock file sync issue**: Regenerated package-lock.json to resolve puppeteer-core version mismatch
  - **Fixed Heroku app.json**: Updated stack to heroku-24, added puppeteer-heroku-buildpack correctly
  - **Auto Base URL Detection**: API documentation now automatically detects the correct base URL from request headers
  - **Node Engine Flexibility**: Updated package.json to support Node.js 18+
  - **Render Config Updated**: Fixed buildCommand and Puppeteer path for Render deployment

- **2024-12-15**: Critical Session Error Fix & API Integration
  - **Fixed "Protocol error (Network.setUserAgentOverride): Session closed" error** - Moved message handler registration inside `createWhatsAppClient()` function
  - **API Key Generation System** - Generate API keys for external application integration
  - **API Documentation** - Complete API docs at `/api/docs` with examples in PHP, Python, Node.js, cURL
  - **Multi-Platform Deployment** - Updated configs for Heroku, Render, Railway, Koyeb
  - **WhatsApp Client Stability** - Automatic retry logic, better error handling, QR re-scan functionality

- **2024-12-13**: Heroku Deployment Fixes
  - **Fixed Puppeteer Chrome Path**: Corrected to `/app/.apt/usr/bin/google-chrome` for Heroku buildpack
  - **Stack Version**: Using heroku-22 (stable)
  - **Optimized Puppeteer Args**: Removed problematic flags, kept memory-efficient options
  - **Added Buildpack Instructions**: Documentation for puppeteer-heroku-buildpack
  - **Updated Postgres Addon**: Changed from deprecated `mini` to `essential-0` plan
  - **Session Warning**: Documented ephemeral filesystem limitation (QR rescan needed after dyno restart)

- **2024-12-13**: Critical Bug Fixes & Security Improvements
  - **Bulk Message Auto-Send Fixed**: Usernames with only numbers are now rejected, preventing "1" from triggering bulk messaging during registration
  - **Duplicate Message Prevention**: Added reply tracking to prevent duplicate responses to same messages
  - **Registration Flow Secured**: Users must complete full registration (enter username) before accessing menu options
  - **Referral Bonus Delay**: Referral bonus only awarded when referred user deposits Ksh 5+ (not on registration)
  - **Pending Referrals Tracking**: New pendingReferrals system to track referrals awaiting first deposit
  - **Exciting Referral Notifications**: Referrers get notified both on signup (pending) and deposit (bonus earned)

- **2024-12-13**: Navigation & Top-up Limits Update
  - **Navigation Standardized**: 0️⃣ = Back, 0️⃣0️⃣ = Main Menu (both users and admins)
  - **Configurable Top-up Limits**: Admin can set min/max top-up amounts (Options 22-23)
  - **Top-up Validation**: Enforces configurable min/max limits
  - **Admin Menu Extended**: Options 22 (Set Min Top-up) and 23 (Set Max Top-up)
  - **Default Settings Added**: topupMinAmount (10), topupMaxAmount (150000)

- **2024-12-13**: Critical Fixes & Deployment Update
  - **Heroku PostgreSQL Fix**: Updated from deprecated `mini` plan to `essential-0`
  - **Chromium Stability**: Fixed profile lock issues with automatic cleanup and proper session management
  - **Contact Upload Fixed**: Option 3 now properly handles manual entry and file uploads with correct flow
  - **Beautiful Menus**: Enhanced WhatsApp messages with box-style formatting and better visuals
  - **Deployment Configs Updated**: All platforms (Render, Koyeb, Railway, Heroku) now use Docker builds
  - **Dockerfile Improved**: Added dumb-init, emoji fonts, non-root user for security
  - **Defensive Code**: getUserMenu now handles incomplete user objects gracefully

- **2024-12-13**: Major Enhancement Update
  - **5 New User Features** (Admin Controllable):
    - Message Templates (Option 9) - Save & reuse messages
    - Referral Program (Option 10) - Earn Ksh 50 per referral
    - User Analytics (Option 11) - Detailed activity stats
    - VIP Status System - Discounted charges for VIP users
    - Scheduled Messages - Toggle available
  - **Maintenance Mode**:
    - Beautiful ASCII-bordered maintenance message
    - Admin toggle via WhatsApp (Option 17)
    - Auto-notification when maintenance ends
  - **Contact File Upload**:
    - Upload CSV, VCF, TXT, or JSON contact files
    - Automatic phone number extraction
    - Manual or file upload choice
  - **Enhanced Admin Panel** (Options 17-20):
    - Toggle Maintenance Mode
    - Edit Maintenance Message
    - Feature Toggles (5 features)
    - VIP User Management
  - Added multer for file upload handling
  - Improved UI with Unicode box-style menus

## Project Architecture

### Main Files
- `main.js` - Main bot application with Express server, WhatsApp client, and payment integration
- `package.json` - Node.js dependencies and scripts
- `users.json` - User data storage (file-based)

### Database Tables
PostgreSQL database with tables:
- `transactions` - Stores all payment transactions
- `bot_settings` - Stores configurable bot texts and values
- `admin_users` - Stores additional admin phone numbers

### Deployment Files
- `Procfile` - Heroku deployment
- `railway.json` - Railway deployment
- `render.yaml` - Render deployment
- `app.json` - Heroku app configuration
- `koyeb.yaml` - Koyeb deployment
- `Dockerfile` & `docker-compose.yml` - Docker support

## Key Features

### 1. WhatsApp Bot
- User registration and management
- Bulk messaging with per-character pricing
- Recipient list management
- Balance tracking and top-ups
- Numbered menu navigation (1-8)

### 2. Shadow Payment Gateway
- M-PESA STK Push integration
- Real-time payment status polling
- Automatic balance updates on successful payments
- Transaction history and tracking

### 3. Admin Dashboard (Port 5000)
- Beautiful glassmorphism UI with tabs
- Dashboard: Stats, QR code, recent transactions
- Users: View all users, modify balances, ban/unban
- Bot Settings: Edit all configurable texts
- Broadcast: Send messages to all users
- Transactions: View full history

### 4. Admin WhatsApp Panel (Options 1-16)
**User Management (1-4):** View users, change cost, modify balance, ban/unban
**Communications (5):** Broadcast to all
**Admin Management (6-7):** Add/remove admins
**System (8-9):** Dashboard URL, transactions
**Bot Settings (10-16):** Edit bot name, welcome text, support text, topup prompt, registration msg, low balance msg, view all settings

## Environment Variables
```
DATABASE_URL - PostgreSQL connection string
SHADOW_API_KEY - Shadow Payment Gateway API Key
SHADOW_API_SECRET - Shadow Payment Gateway API Secret
SHADOW_ACCOUNT_ID - Shadow Payment Account ID (default: 17)
SUPER_ADMIN - Super admin WhatsApp number (e.g., 254712345678)
ADMIN_LABEL - Admin label shown in broadcasts
PORT - Web server port (default: 5000)
```

## API Endpoints

### Dashboard & Status
- `GET /` - Admin dashboard
- `GET /health` - Health check
- `GET /ping` - Keep-alive ping
- `GET /keep-alive` - Keep-alive endpoint
- `GET /api/docs` - API documentation page

### Bot Settings
- `GET /api/settings` - Get bot settings
- `POST /api/settings` - Update single setting
- `POST /api/settings/bulk` - Update multiple settings

### User Management
- `GET /api/users` - Get all users
- `POST /api/users/:phone/balance` - Modify user balance
- `POST /api/users/:phone/ban` - Ban/unban user

### Messaging
- `POST /api/broadcast` - Send broadcast
- `GET /api/transactions` - Get transactions
- `GET /api/stats` - Get statistics

### External API (Requires API Key)
- `POST /api/v1/send` - Send WhatsApp message (Bearer token auth)
- `GET /api/v1/status` - Check bot status (Bearer token auth)
- `POST /api/v1/logout` - Logout WhatsApp session (Bearer token auth)
- `POST /api/v1/reconnect` - Reconnect WhatsApp client (Bearer token auth)

### API Key Management
- `GET /api/keys` - List all API keys
- `POST /api/keys` - Generate new API key
- `DELETE /api/keys/:id` - Delete API key

## Keep-Alive
Built-in keep-alive mechanism pings itself every 4 minutes to prevent sleeping on free-tier platforms.

## User Preferences
- All messages include engaging emojis and formatting
- Menu navigation uses numbers (1-8 for users, 1-16 for admins)
- Balance displayed in KES (Kenyan Shillings)
- Time zone: Africa/Nairobi
