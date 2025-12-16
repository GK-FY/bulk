/*******************************************************************
 * main.js
 * FY'S PROPERTY WHATSAPP BOT - PREMIUM EDITION
 * Fully Configurable via WhatsApp & Dashboard
 * Deploy-ready for: Heroku, Render, Railway, Koyeb
 *******************************************************************/

const { Client, LocalAuth } = require('whatsapp-web.js');
const express        = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode         = require('qrcode');
const axios          = require('axios');
const fs             = require('fs');
const path           = require('path');
const { Pool }       = require('pg');
const multer         = require('multer');
const crypto         = require('crypto');

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.csv', '.vcf', '.txt', '.json'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only CSV, VCF, TXT, JSON files allowed'));
  }
});

const USER_SUFFIX = "\n\n0️⃣ Back   0️⃣0️⃣ Main Menu";

let pool = null;
let dbAvailable = false;

function initPool() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️ DATABASE_URL not set - running without database');
    return null;
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
  });
}

pool = initPool();

async function initDatabase(retryCount = 0) {
  const MAX_DB_RETRIES = 3;
  
  if (!pool) {
    console.log('⚠️ DATABASE_URL not set - database features disabled');
    console.log('💡 To enable API keys and transactions, set DATABASE_URL environment variable');
    return;
  }
  
  try {
    console.log('🔄 Connecting to database...');
    await pool.query('SELECT 1');
    console.log('✅ Database connection successful');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        reference VARCHAR(50) UNIQUE NOT NULL,
        checkout_request_id VARCHAR(100),
        merchant_request_id VARCHAR(100),
        user_id VARCHAR(50),
        user_name VARCHAR(100),
        phone VARCHAR(20) NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        transaction_code VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        setting_key VARCHAR(100) UNIQUE NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(50) UNIQUE NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        key_id VARCHAR(50) UNIQUE NOT NULL,
        api_key VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        permissions TEXT DEFAULT 'read',
        is_active BOOLEAN DEFAULT true,
        last_used TIMESTAMP,
        requests_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
    `);
    
    console.log('✅ Database initialized successfully');
    dbAvailable = true;
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    dbAvailable = false;
    
    if (retryCount < MAX_DB_RETRIES) {
      console.log(`🔄 Retrying database connection in 5 seconds... (${retryCount + 1}/${MAX_DB_RETRIES})`);
      setTimeout(() => initDatabase(retryCount + 1), 5000);
    } else {
      console.log('⚠️ Database connection failed after retries. API keys and transactions disabled.');
      console.log('💡 Check your DATABASE_URL environment variable');
    }
  }
}

async function getSetting(key, defaultValue = '') {
  if (!pool || !dbAvailable) return defaultValue;
  try {
    const result = await pool.query('SELECT setting_value FROM bot_settings WHERE setting_key = $1', [key]);
    return result.rows.length > 0 ? result.rows[0].setting_value : defaultValue;
  } catch (err) {
    console.error(`❌ Error getting setting ${key}:`, err.message);
    return defaultValue;
  }
}

async function setSetting(key, value) {
  if (!pool || !dbAvailable) return false;
  try {
    await pool.query(`
      INSERT INTO bot_settings (setting_key, setting_value, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (setting_key) DO UPDATE SET
        setting_value = EXCLUDED.setting_value,
        updated_at = CURRENT_TIMESTAMP
    `, [key, value]);
    return true;
  } catch (err) {
    console.error(`❌ Error setting ${key}:`, err.message);
    return false;
  }
}

async function getAllSettings() {
  if (!pool || !dbAvailable) return {};
  try {
    const result = await pool.query('SELECT setting_key, setting_value FROM bot_settings');
    const settings = {};
    for (const row of result.rows) {
      settings[row.setting_key] = row.setting_value;
    }
    return settings;
  } catch (err) {
    console.error('❌ Error getting all settings:', err.message);
    return {};
  }
}

async function saveTransaction(txn) {
  if (!pool || !dbAvailable) return null;
  try {
    const result = await pool.query(
      `INSERT INTO transactions (reference, checkout_request_id, merchant_request_id, user_id, user_name, phone, amount, status, transaction_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (reference) DO UPDATE SET
         status = EXCLUDED.status,
         transaction_code = EXCLUDED.transaction_code,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [txn.reference, txn.checkoutRequestId, txn.merchantRequestId, txn.userId, txn.userName, txn.phone, txn.amount, txn.status, txn.transactionCode]
    );
    return result.rows[0];
  } catch (err) {
    console.error('❌ Error saving transaction:', err.message);
    return null;
  }
}

async function updateTransactionStatus(checkoutRequestId, status, transactionCode = null) {
  if (!pool || !dbAvailable) return;
  try {
    await pool.query(
      `UPDATE transactions SET status = $1, transaction_code = $2, updated_at = CURRENT_TIMESTAMP WHERE checkout_request_id = $3`,
      [status, transactionCode, checkoutRequestId]
    );
  } catch (err) {
    console.error('❌ Error updating transaction:', err.message);
  }
}

async function getTransactions(limit = 100) {
  if (!pool || !dbAvailable) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.error('❌ Error fetching transactions:', err.message);
    return [];
  }
}

async function getTransactionStats() {
  if (!pool || !dbAvailable) return { total: 0, completed: 0, pending: 0, failed: 0, total_deposits: 0 };
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) as total_deposits
      FROM transactions
    `);
    return result.rows[0];
  } catch (err) {
    console.error('❌ Error fetching stats:', err.message);
    return { total: 0, completed: 0, pending: 0, failed: 0, total_deposits: 0 };
  }
}

async function addAdminToDb(phone) {
  if (!pool || !dbAvailable) return false;
  try {
    await pool.query(
      'INSERT INTO admin_users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING',
      [phone]
    );
    return true;
  } catch (err) {
    console.error('❌ Error adding admin:', err.message);
    return false;
  }
}

async function removeAdminFromDb(phone) {
  if (!pool || !dbAvailable) return false;
  try {
    await pool.query('DELETE FROM admin_users WHERE phone = $1', [phone]);
    return true;
  } catch (err) {
    console.error('❌ Error removing admin:', err.message);
    return false;
  }
}

async function getAdminsFromDb() {
  if (!pool || !dbAvailable) return [];
  try {
    const result = await pool.query('SELECT phone FROM admin_users');
    return result.rows.map(r => r.phone);
  } catch (err) {
    console.error('❌ Error getting admins:', err.message);
    return [];
  }
}

function generateApiKey() {
  const keyId = 'fys_' + crypto.randomBytes(8).toString('hex');
  const apiKey = 'sk_' + crypto.randomBytes(32).toString('hex');
  return { keyId, apiKey };
}

async function createApiKey(name, permissions = 'read,write') {
  if (!pool || !dbAvailable) return null;
  try {
    const { keyId, apiKey } = generateApiKey();
    const result = await pool.query(
      `INSERT INTO api_keys (key_id, api_key, name, permissions) VALUES ($1, $2, $3, $4) RETURNING *`,
      [keyId, apiKey, name, permissions]
    );
    return { ...result.rows[0], api_key: apiKey };
  } catch (err) {
    console.error('❌ Error creating API key:', err.message);
    return null;
  }
}

async function validateApiKey(apiKey) {
  if (!pool || !dbAvailable) return null;
  try {
    const result = await pool.query(
      `UPDATE api_keys SET last_used = CURRENT_TIMESTAMP, requests_count = requests_count + 1 
       WHERE api_key = $1 AND is_active = true RETURNING *`,
      [apiKey]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    console.error('❌ Error validating API key:', err.message);
    return null;
  }
}

async function getApiKeys() {
  if (!pool || !dbAvailable) return [];
  try {
    const result = await pool.query(
      `SELECT id, key_id, name, permissions, is_active, last_used, requests_count, created_at FROM api_keys ORDER BY created_at DESC`
    );
    return result.rows;
  } catch (err) {
    console.error('❌ Error getting API keys:', err.message);
    return [];
  }
}

async function revokeApiKey(keyId) {
  if (!pool || !dbAvailable) return false;
  try {
    await pool.query(`UPDATE api_keys SET is_active = false WHERE key_id = $1`, [keyId]);
    return true;
  } catch (err) {
    console.error('❌ Error revoking API key:', err.message);
    return false;
  }
}

async function deleteApiKey(keyId) {
  if (!pool || !dbAvailable) return false;
  try {
    await pool.query(`DELETE FROM api_keys WHERE key_id = $1`, [keyId]);
    return true;
  } catch (err) {
    console.error('❌ Error deleting API key:', err.message);
    return false;
  }
}

const DATA_PATH = path.join(__dirname, 'users.json');

function loadUsers() {
  return fs.existsSync(DATA_PATH)
    ? JSON.parse(fs.readFileSync(DATA_PATH))
    : {};
}
function saveUsers(usersData) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(usersData, null, 2));
}

let users = loadUsers();

const config = {
  apiKey: 'Admin-api1234',
  apiSecret: 'Admin-secret1234',
  paymentAccountId: '8',
  superAdmin: process.env.SUPER_ADMIN || '254101343265',
  fromAdmin: process.env.ADMIN_LABEL || 'Admin GK-FY',
  costPerChar: parseFloat(process.env.COST_PER_CHAR) || 0.01
};

if (!config.apiKey || !config.apiSecret) {
  console.log('⚠️ SHADOW_API_KEY and SHADOW_API_SECRET not configured - payments will be disabled');
}

const SUPER_ADMIN = config.superAdmin + '@c.us';
let adminUsers = new Set([SUPER_ADMIN]);

const DEFAULT_SETTINGS = {
  botName: "FY'S PROPERTY",
  fromAdmin: config.fromAdmin,
  costPerChar: String(config.costPerChar),
  maintenanceMode: 'false',
  maintenanceMessage: `
╔══════════════════════════════════════╗
║  🔧 *SCHEDULED MAINTENANCE* 🔧       ║
╠══════════════════════════════════════╣
║                                      ║
║  ⚙️  We're upgrading our systems     ║
║      to serve you better!            ║
║                                      ║
║  ⏰  *Estimated Return:*             ║
║      Within 1-2 hours                ║
║                                      ║
║  💡  *While you wait:*               ║
║      • Check our social media        ║
║      • Prepare your messages         ║
║      • Invite friends to join!       ║
║                                      ║
║  🙏  Thank you for your patience!    ║
║                                      ║
╚══════════════════════════════════════╝

_We'll notify you when we're back online!_ ✨`,
  featureReferrals: 'true',
  featureScheduledMsgs: 'true',
  featureTemplates: 'true',
  featureAnalytics: 'true',
  featureVIP: 'true',
  referralBonus: '50',
  vipDiscount: '20',
  topupMinAmount: '10',
  topupMaxAmount: '150000',
  welcomeText: `🌟✨ *Welcome to FY'S PROPERTY!* ✨🌟

We're thrilled to have you here! 🎊

🚀 *Getting Started:*
Simply *send your desired username* to create your account! ✨

💡 _Choose something unique and memorable!_ 🔥

🎁 *What You'll Get:*
• 📲 Instant Bulk Messaging
• 💰 Easy M-PESA Top-ups
• 📊 Real-time Balance Tracking
• 🆘 24/7 Premium Support

Let's create your account now! 💪`,
  supportText: `🆘💬 *Premium Support Center* 💬🆘

We're here to help you 24/7! 🌟

📧 *Email:* support@fysproperty.com
📱 *WhatsApp:* Chat with us here!
⏰ *Response Time:* Usually within minutes!

💡 *Quick Help:*
• Balance issues? Option 6
• Top-up problems? Option 5
• Account help? We're one message away!

🙏 _Thank you for choosing us!_ 🙏`,
  topupPrompt: `💳✨ *Time to Power Up Your Wallet!* ✨💳

🔢 How much would you like to add?

💰 *Minimum:* Ksh 11
💎 *Maximum:* Unlimited!

📱 _Just type the amount (e.g., 100):_`,
  regSuccessTemplate: `🎉🎊 *CONGRATULATIONS, {name}!* 🎊🎉

🌟 Your premium account has been created! 🌟

💰 *Starting Balance:* Ksh 0.00

🚀 *Quick Start:*
• Step 1: Add recipients (Option 3)
• Step 2: Top-up your balance (Option 5)
• Step 3: Start broadcasting! (Option 1)

🔥 _You're all set!_ 🔥`,
  notEnoughBalTemplate: `⚠️ *Insufficient Funds* ⚠️

📊 *Broadcast Cost:* Ksh {cost}
💰 *Your Balance:* Ksh {balance}
📉 *Shortfall:* Ksh {shortfall}

💡 *Quick Fix:* Top-up now with Option 5!
⚡ _Instant M-PESA loading available!_ ⚡`
};

let botSettings = { ...DEFAULT_SETTINGS };

async function loadBotSettings() {
  const dbSettings = await getAllSettings();
  for (const key in DEFAULT_SETTINGS) {
    if (dbSettings[key]) {
      botSettings[key] = dbSettings[key];
    }
  }
  
  const dbAdmins = await getAdminsFromDb();
  for (const phone of dbAdmins) {
    adminUsers.add(phone);
  }
}

async function initializeDefaultSettings() {
  const existing = await getAllSettings();
  for (const key in DEFAULT_SETTINGS) {
    if (!existing[key]) {
      await setSetting(key, DEFAULT_SETTINGS[key]);
    }
  }
}

function getBotName() {
  return botSettings.botName || DEFAULT_SETTINGS.botName;
}

function getWelcomeText() {
  let text = botSettings.welcomeText || DEFAULT_SETTINGS.welcomeText;
  return text.replace(/FY'S PROPERTY/g, getBotName());
}

function getSupportText() {
  let text = botSettings.supportText || DEFAULT_SETTINGS.supportText;
  return text.replace(/FY'S PROPERTY/g, getBotName());
}

function getTopupPrompt() {
  const minAmount = parseFloat(botSettings.topupMinAmount) || 10;
  const maxAmount = parseFloat(botSettings.topupMaxAmount) || 150000;
  return `💳✨ *Time to Power Up Your Wallet!* ✨💳

🔢 How much would you like to add?

💰 *Minimum:* Ksh ${minAmount}
💎 *Maximum:* Ksh ${maxAmount}

📱 _Just type the amount (e.g., 100):_`;
}

function getRegSuccess(name) {
  let text = botSettings.regSuccessTemplate || DEFAULT_SETTINGS.regSuccessTemplate;
  text = text.replace(/\{name\}/g, name);
  const newUserObj = {
    name: name,
    balance: 0,
    messageCount: 0,
    recipients: [],
    vip: false
  };
  return text + '\n\n' + getUserMenu(newUserObj);
}

function getNotEnoughBal(cost, balance) {
  let text = botSettings.notEnoughBalTemplate || DEFAULT_SETTINGS.notEnoughBalTemplate;
  text = text.replace(/\{cost\}/g, cost.toFixed(2));
  text = text.replace(/\{balance\}/g, balance.toFixed(2));
  text = text.replace(/\{shortfall\}/g, (cost - balance).toFixed(2));
  return text;
}

function isFeatureEnabled(feature) {
  return botSettings[feature] === 'true' || botSettings[feature] === true;
}

function isMaintenanceMode() {
  return botSettings.maintenanceMode === 'true' || botSettings.maintenanceMode === true;
}

function getMaintenanceMessage() {
  return botSettings.maintenanceMessage || DEFAULT_SETTINGS.maintenanceMessage;
}

function getUserMenu(user) {
  const botName = getBotName();
  const isVIP = user.vip === true;
  const vipBadge = isVIP ? ' 👑' : '';
  const vipLabel = isVIP ? '  ║  👑 VIP Member' : '';
  const balance = user.balance || 0;
  const messageCount = user.messageCount || 0;
  const recipientCount = user.recipients?.length || 0;
  
  let menu = `
╔═══════════════════════════════════════╗
║  🌟 *${botName}* 🌟                  
╠═══════════════════════════════════════╣
║  👋 Hello, *${user.name}*!${vipBadge}
║───────────────────────────────────────
║  💰 Balance: *Ksh ${balance.toFixed(2)}*
║  📤 Sent: *${messageCount}* messages
║  👥 Recipients: *${recipientCount}* contacts${vipLabel}
╠═══════════════════════════════════════╣
║           📋 *MAIN MENU*              
╠═══════════════════════════════════════╣
║                                       
║  1️⃣  📢 *Send Bulk Message*          
║       Broadcast to all contacts       
║                                       
║  2️⃣  👥 *View Recipients*            
║       See your contact list           
║                                       
║  3️⃣  ➕ *Add Recipients*             
║       Manual entry or file upload     
║                                       
║  4️⃣  ❌ *Remove Recipient*           
║       Delete from your list           
║                                       
║  5️⃣  💳 *Top-up Balance*             
║       Add funds via M-PESA            
║                                       
║  6️⃣  💰 *Check Balance*              
║       View account details            
║                                       
║  7️⃣  🆘 *Contact Support*            
║       Get help anytime                
║                                       
║  8️⃣  🗑️ *Delete Account*             
║       Remove your account`;

  if (isFeatureEnabled('featureTemplates')) {
    menu += `             
║                                       
║  9️⃣  📋 *Message Templates*          
║       Save & reuse messages`;
  }
  
  if (isFeatureEnabled('featureReferrals')) {
    menu += `           
║                                       
║  🔟  🎁 *Referral Program*           
║       Earn Ksh ${(botSettings.referralBonus || 50).toString().padEnd(5)}per invite`;
  }
  
  if (isFeatureEnabled('featureAnalytics')) {
    menu += `          
║                                       
║  1️⃣1️⃣ 📊 *My Analytics*              
║       View your statistics`;
  }

  menu += `            
║                                       
╚═══════════════════════════════════════╝

📱 *Reply with a number to continue*
0️⃣ Back   0️⃣0️⃣ Main Menu`;
  return menu;
}

function getAdminMenu() {
  const botName = getBotName();
  const maintenanceStatus = isMaintenanceMode() ? '🔴 ON' : '🟢 OFF';
  const userCount = Object.keys(users).length;
  
  return `
╔═══════════════════════════════════════╗
║  🛡️ *${botName}* - ADMIN PANEL 🛡️    
╠═══════════════════════════════════════╣
║  👥 Users: *${userCount}*  │  🔧 Maintenance: ${maintenanceStatus}
╠═══════════════════════════════════════╣
║                                       
║  📊 *USER MANAGEMENT*                 
║  ─────────────────────                
║  1️⃣  👥 View All Users               
║  2️⃣  💱 Change Cost/Char             
║  3️⃣  💰 Modify User Balance          
║  4️⃣  🚫 Ban/Unban User               
║                                       
╠═══════════════════════════════════════╣
║                                       
║  📢 *COMMUNICATIONS*                  
║  ─────────────────────                
║  5️⃣  📢 Broadcast to All             
║                                       
╠═══════════════════════════════════════╣
║                                       
║  👮 *ADMIN MANAGEMENT*                
║  ─────────────────────                
║  6️⃣  ➕ Add Admin                    
║  7️⃣  ❌ Remove Admin                 
║                                       
╠═══════════════════════════════════════╣
║                                       
║  🌐 *SYSTEM*                          
║  ─────────────────────                
║  8️⃣  🔗 View Dashboard URL           
║  9️⃣  💳 Recent Transactions          
║                                       
╠═══════════════════════════════════════╣
║                                       
║  ⚙️ *BOT SETTINGS*                    
║  ─────────────────────                
║  10  📝 Edit Bot Name                 
║  11  👋 Edit Welcome Text             
║  12  🆘 Edit Support Text             
║  13  💳 Edit Topup Prompt             
║  14  🎉 Edit Registration Msg         
║  15  ⚠️ Edit Low Balance Msg          
║  16  📋 View All Settings             
║                                       
╠═══════════════════════════════════════╣
║                                       
║  🔧 *MAINTENANCE & FEATURES*          
║  ─────────────────────                
║  17  🔧 Toggle Maintenance Mode       
║  18  ✏️ Edit Maintenance Message      
║  19  ⚡ Feature Toggles               
║  20  👑 Manage VIP Users              
║  21  🎁 Set Referral Bonus            
║  22  📉 Set Min Top-up Amount         
║  23  📈 Set Max Top-up Amount         
║                                       
╚═══════════════════════════════════════╝

📱 *Reply with a number to continue*
0️⃣ Back   0️⃣0️⃣ Refresh Menu`;
}

const conversations = {};
const adminSessions = {};
const processedMessages = new Set();
const MESSAGE_CACHE_TTL = 60000;

function getChromiumPath() {
  console.log('🔍 Detecting Chromium/Chrome installation...');
  
  const envVars = ['PUPPETEER_EXECUTABLE_PATH', 'GOOGLE_CHROME_BIN', 'CHROMIUM_PATH', 'CHROME_BIN'];
  for (const envVar of envVars) {
    if (process.env[envVar]) {
      console.log(`🌐 Found ${envVar}: ${process.env[envVar]}`);
      if (fs.existsSync(process.env[envVar])) {
        console.log(`✅ Using ${envVar}`);
        return process.env[envVar];
      } else {
        console.log(`⚠️ ${envVar} path does not exist, trying next...`);
      }
    }
  }
  
  try {
    const nixChromium = require('child_process').execSync('which chromium 2>/dev/null || echo ""').toString().trim();
    if (nixChromium && fs.existsSync(nixChromium)) {
      console.log(`✅ Found chromium at: ${nixChromium}`);
      return nixChromium;
    }
  } catch {}
  
  try {
    const googleChrome = require('child_process').execSync('which google-chrome 2>/dev/null || which google-chrome-stable 2>/dev/null || echo ""').toString().trim();
    if (googleChrome && fs.existsSync(googleChrome)) {
      console.log(`✅ Found google-chrome at: ${googleChrome}`);
      return googleChrome;
    }
  } catch {}
  
  const possiblePaths = [
    '/app/.apt/usr/bin/google-chrome-stable',
    '/app/.apt/usr/bin/google-chrome',
    '/app/.chrome-for-testing/chrome-linux64/chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome',
  ];
  
  console.log('🔍 Checking common installation paths...');
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log(`✅ Found Chrome at: ${p}`);
      return p;
    }
  }
  
  console.log('⚠️ No Chrome/Chromium found - will try bundled Puppeteer Chromium');
  return undefined;
}

const chromiumPath = getChromiumPath();
console.log('🌐 Chromium path:', chromiumPath || 'Using bundled Puppeteer Chromium');

const sessionDataPath = path.join(__dirname, '.wwebjs_auth');
const cachePath = path.join(__dirname, '.wwebjs_cache');

function cleanupChromiumLocks() {
  try {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    const sessionDir = path.join(sessionDataPath, 'session');
    
    if (fs.existsSync(sessionDir)) {
      for (const lockFile of lockFiles) {
        const lockPath = path.join(sessionDir, lockFile);
        try {
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            console.log(`🧹 Removed lock file: ${lockFile}`);
          }
        } catch (e) {
          console.log(`⚠️ Could not remove ${lockFile}:`, e.message);
        }
      }
      
      const allFiles = fs.readdirSync(sessionDir);
      for (const file of allFiles) {
        if (file.startsWith('Singleton') || file === 'lockfile') {
          try {
            fs.unlinkSync(path.join(sessionDir, file));
            console.log(`🧹 Removed: ${file}`);
          } catch (e) {}
        }
      }
    }
    
    if (fs.existsSync(cachePath)) {
      const cacheContents = fs.readdirSync(cachePath);
      for (const item of cacheContents) {
        if (item.startsWith('chromium-profile-')) {
          const itemPath = path.join(cachePath, item);
          try {
            fs.rmSync(itemPath, { recursive: true, force: true });
            console.log(`🧹 Cleaned old profile: ${item}`);
          } catch (e) {}
        }
      }
    }
    
    console.log('🧹 Chromium lock cleanup completed');
  } catch (err) {
    console.log('⚠️ Lock cleanup error:', err.message);
  }
}

if (!fs.existsSync(cachePath)) {
  fs.mkdirSync(cachePath, { recursive: true });
}

cleanupChromiumLocks();

const puppeteerOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--no-default-browser-check',
    '--disable-features=VizDisplayCompositor,site-per-process',
    '--disable-software-rasterizer',
    '--disable-web-security',
    '--disable-features=IsolateOrigins',
    '--disable-site-isolation-trials',
    '--ignore-certificate-errors',
    '--single-process',
    '--no-zygote',
    '--disable-infobars',
    '--window-size=1280,800',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=AudioServiceOutOfProcess',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    '--metrics-recording-only'
  ],
  timeout: 60000,
  protocolTimeout: 60000
};

if (chromiumPath) {
  puppeteerOptions.executablePath = chromiumPath;
}

let client = null;
let currentQR = "";
let botReady = false;
let isInitializing = false;
let initRetryCount = 0;
const MAX_INIT_RETRIES = 3;

// API Logs storage
let apiLogs = [];
const MAX_API_LOGS = 500;

function logApiRequest(req, res, responseBody, startTime) {
  const duration = Date.now() - startTime;
  const log = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl || req.url,
    status: res.statusCode,
    duration: duration,
    ip: req.ip || req.connection?.remoteAddress || 'unknown',
    userAgent: req.get('User-Agent') || 'unknown',
    requestBody: req.method !== 'GET' ? sanitizeLogData(req.body) : null,
    responsePreview: typeof responseBody === 'string' ? responseBody.substring(0, 200) : JSON.stringify(responseBody).substring(0, 200),
    success: res.statusCode >= 200 && res.statusCode < 400
  };
  
  apiLogs.unshift(log);
  if (apiLogs.length > MAX_API_LOGS) {
    apiLogs = apiLogs.slice(0, MAX_API_LOGS);
  }
}

function sanitizeLogData(data) {
  if (!data) return null;
  const sanitized = { ...data };
  const sensitiveKeys = ['password', 'api_key', 'apiKey', 'secret', 'token', 'authorization'];
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '***REDACTED***';
    }
  }
  return sanitized;
}

function createWhatsAppClient() {
  cleanupChromiumLocks();
  
  const newClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: sessionDataPath
    }),
    puppeteer: puppeteerOptions,
    webVersionCache: {
      type: 'local',
      path: cachePath
    },
    restartOnAuthFail: true
  });
  
  newClient.on('qr', qr => {
    currentQR = qr;
    botError = null;
    console.log('\n');
    console.log('═══════════════════════════════════════════════════════');
    console.log('📱 QR CODE READY - SCAN WITH WHATSAPP TO CONNECT');
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('📌 Open WhatsApp > Settings > Linked Devices > Link Device');
    console.log('═══════════════════════════════════════════════════════\n');
  });

  newClient.on('ready', async () => {
    console.log('🚀 Bot is ready and connected!');
    botReady = true;
    currentQR = "";
    botError = null;
    isInitializing = false;
    initRetryCount = 0;
  
    await loadBotSettings();
  
    const stats = await getTransactionStats();
    const botName = getBotName();
  
    adminReply(SUPER_ADMIN,
      `🤖✨ *${botName} Bot* is now ONLINE! ✨🤖

🔥 All systems are GO! 🔥

📊 *Quick Stats:*
• 👥 Users: ${Object.keys(users).length}
• 💳 Transactions: ${stats.total}
• 💰 Total Deposits: Ksh ${parseFloat(stats.total_deposits || 0).toFixed(2)}

Use the menu below to manage everything! 👇`
    );
    showAdminMenu(SUPER_ADMIN);
  });

  newClient.on('disconnected', (reason) => {
    console.log('⚠️ Bot disconnected:', reason);
    botReady = false;
    currentQR = "";
    
    setTimeout(() => {
      if (!isInitializing && initRetryCount < MAX_INIT_RETRIES) {
        console.log('🔄 Attempting to reconnect...');
        initializeWhatsApp();
      }
    }, 5000);
  });

  newClient.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    botError = 'Authentication failed. Please scan QR code again.';
    botReady = false;
  });
  
  newClient.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
  });
  
  setupMessageHandler(newClient);
  
  return newClient;
}

async function initializeWhatsApp() {
  if (isInitializing) {
    console.log('⚠️ WhatsApp initialization already in progress');
    return;
  }
  
  isInitializing = true;
  botError = null;
  
  try {
    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        console.log('⚠️ Error destroying old client:', e.message);
      }
    }
    
    cleanupChromiumLocks();
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('🔄 Starting WhatsApp client - QR code will appear shortly...');
    client = createWhatsAppClient();
    
    await client.initialize();
    console.log('✅ WhatsApp client initialized successfully');
  } catch (err) {
    console.error('❌ WhatsApp initialization error:', err.message);
    isInitializing = false;
    
    if (initRetryCount < MAX_INIT_RETRIES) {
      initRetryCount++;
      console.log(`🔄 Retry ${initRetryCount}/${MAX_INIT_RETRIES} in 10 seconds...`);
      setTimeout(() => initializeWhatsApp(), 10000);
    } else {
      console.log('⚠️ WhatsApp initialization failed after retries - waiting for manual reconnect');
    }
  }
}

async function logoutWhatsApp() {
  try {
    botReady = false;
    currentQR = "";
    
    if (client) {
      try {
        await client.logout();
      } catch (e) {
        console.log('⚠️ Logout error:', e.message);
      }
      try {
        await client.destroy();
      } catch (e) {
        console.log('⚠️ Destroy error:', e.message);
      }
    }
    
    if (fs.existsSync(sessionDataPath)) {
      fs.rmSync(sessionDataPath, { recursive: true, force: true });
      console.log('🧹 Session data cleared');
    }
    
    cleanupChromiumLocks();
    
    return true;
  } catch (err) {
    console.error('❌ Logout error:', err.message);
    return false;
  }
}

let botError = null;

const app = express();
const PORT = process.env.PORT || 5000;

function getBaseUrl(req) {
  if (req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname;
    if (host && !host.includes('localhost')) {
      return `${protocol}://${host}`;
    }
  }
  return process.env.SELF_URL || 
         process.env.RENDER_EXTERNAL_URL || 
         process.env.RAILWAY_STATIC_URL || 
         process.env.HEROKU_APP_URL ||
         (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : null) ||
         `http://localhost:${PORT}`;
}

const SELF_URL = getBaseUrl(null);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Logging Middleware for /api/* routes
app.use('/api', (req, res, next) => {
  const startTime = Date.now();
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  
  res.json = function(body) {
    logApiRequest(req, res, body, startTime);
    return originalJson(body);
  };
  
  res.send = function(body) {
    if (req.path !== '/logs') {
      logApiRequest(req, res, body, startTime);
    }
    return originalSend(body);
  };
  
  next();
});

// Get API Logs endpoint
app.get("/api/logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const method = req.query.method;
  const status = req.query.status;
  
  let filteredLogs = [...apiLogs];
  
  if (method) {
    filteredLogs = filteredLogs.filter(log => log.method === method.toUpperCase());
  }
  
  if (status === 'success') {
    filteredLogs = filteredLogs.filter(log => log.success);
  } else if (status === 'error') {
    filteredLogs = filteredLogs.filter(log => !log.success);
  }
  
  res.json({
    success: true,
    total: apiLogs.length,
    filtered: filteredLogs.length,
    logs: filteredLogs.slice(0, limit)
  });
});

// Clear API Logs endpoint
app.post("/api/logs/clear", (req, res) => {
  apiLogs = [];
  res.json({ success: true, message: 'API logs cleared' });
});

app.get("/health", (req, res) => {
  res.json({
    status: 'alive',
    botReady,
    botError,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

app.get("/keep-alive", (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

const pendingPayments = new Map();

app.post("/api/payment/callback", async (req, res) => {
  try {
    console.log('📥 Payment Callback Received:', JSON.stringify(req.body, null, 2));
    
    const { 
      checkout_request_id, 
      status, 
      transaction_code, 
      reference,
      amount,
      phone
    } = req.body;
    
    if (!checkout_request_id) {
      return res.status(400).json({ success: false, message: 'Missing checkout_request_id' });
    }
    
    const paymentData = pendingPayments.get(checkout_request_id);
    
    if (status === 'completed' || status === 'success') {
      if (paymentData) {
        const { userId, user, amount: paymentAmount } = paymentData;
        
        user.balance += paymentAmount;
        saveUsers(users);
        
        await updateTransactionStatus(checkout_request_id, 'completed', transaction_code);
        
        const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' });
        
        await safeSend(userId,
          `🎉✨ *TOP-UP SUCCESSFUL!* ✨🎉\n\n` +
          `💰 *Amount:* Ksh ${paymentAmount.toFixed(2)}\n` +
          `📱 *M-PESA Code:* ${transaction_code || 'N/A'}\n` +
          `💵 *New Balance:* Ksh ${user.balance.toFixed(2)}\n\n` +
          `🙏 Thank you for your payment!\n` +
          `🚀 _Your balance has been updated instantly!_`
        );
        
        await safeSend(SUPER_ADMIN,
          `💰💰 *DEPOSIT ALERT!* 💰💰\n\n` +
          `👤 *User:* ${user.name}\n` +
          `📱 *Phone:* ${user.phone}\n` +
          `💵 *Amount:* Ksh ${paymentAmount.toFixed(2)}\n` +
          `🔖 *Code:* ${transaction_code || 'N/A'}\n` +
          `🕐 *Time:* ${now}`
        );
        
        pendingPayments.delete(checkout_request_id);
        console.log('✅ Payment processed via callback:', checkout_request_id);
      } else {
        await updateTransactionStatus(checkout_request_id, 'completed', transaction_code);
        console.log('✅ Transaction updated via callback (no pending data):', checkout_request_id);
      }
    } else if (status === 'failed' || status === 'cancelled') {
      await updateTransactionStatus(checkout_request_id, 'failed');
      
      if (paymentData) {
        await safeSend(paymentData.userId,
          `❌ *Payment Failed* ❌\n\n` +
          `Your M-PESA payment was not completed.\n\n` +
          `Type *5* to try again.`
        );
        pendingPayments.delete(checkout_request_id);
      }
      console.log('❌ Payment failed via callback:', checkout_request_id);
    }
    
    res.json({ success: true, message: 'Callback processed' });
  } catch (err) {
    console.error('❌ Callback Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    await loadBotSettings();
    res.json({ success: true, settings: botSettings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, error: 'Missing key or value' });
    }
    await setSetting(key, value);
    botSettings[key] = value;
    res.json({ success: true, message: 'Setting updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/settings/bulk", async (req, res) => {
  try {
    const { settings } = req.body;
    for (const key in settings) {
      await setSetting(key, settings[key]);
      botSettings[key] = settings[key];
    }
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/users", (req, res) => {
  const userList = Object.entries(users).map(([jid, u]) => ({
    jid,
    name: u.name,
    phone: u.phone,
    balance: u.balance,
    messageCount: u.messageCount,
    totalCharges: u.totalCharges,
    banned: u.banned,
    banReason: u.banReason,
    registeredAt: u.registeredAt,
    recipientCount: u.recipients?.length || 0
  }));
  res.json({ success: true, users: userList });
});

app.post("/api/users/:phone/balance", (req, res) => {
  try {
    const phone = req.params.phone;
    const { amount, operation } = req.body;
    
    let jid = phone.includes('@c.us') ? phone : phone + '@c.us';
    if (!jid.startsWith('254') && !jid.includes('@')) {
      jid = '254' + jid.replace(/^0/, '') + '@c.us';
    }
    
    if (!users[jid]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const amt = parseFloat(amount);
    if (operation === 'add') {
      users[jid].balance += amt;
    } else if (operation === 'subtract') {
      users[jid].balance -= amt;
    } else if (operation === 'set') {
      users[jid].balance = amt;
    }
    
    saveUsers(users);
    res.json({ success: true, newBalance: users[jid].balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/users/:phone/ban", (req, res) => {
  try {
    const phone = req.params.phone;
    const { ban, reason } = req.body;
    
    let jid = phone.includes('@c.us') ? phone : phone + '@c.us';
    if (!jid.startsWith('254') && !jid.includes('@')) {
      jid = '254' + jid.replace(/^0/, '') + '@c.us';
    }
    
    if (!users[jid]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    users[jid].banned = ban;
    users[jid].banReason = ban ? reason : '';
    saveUsers(users);
    
    res.json({ success: true, banned: users[jid].banned });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/broadcast", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message required' });
    }
    
    const userList = Object.keys(users);
    let sent = 0;
    
    for (const jid of userList) {
      await safeSend(jid, `📢 *${botSettings.fromAdmin || config.fromAdmin}:*\n\n${message}`);
      sent++;
    }
    
    res.json({ success: true, sent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/whatsapp/logout", async (req, res) => {
  try {
    await logoutWhatsApp();
    res.json({ success: true, message: 'Logged out successfully. Scan QR code to reconnect.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/whatsapp/reconnect", async (req, res) => {
  try {
    initRetryCount = 0;
    isInitializing = false;
    await initializeWhatsApp();
    res.json({ success: true, message: 'Reconnection initiated. Please wait for QR code.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/whatsapp/status", (req, res) => {
  res.json({
    success: true,
    status: {
      connected: botReady,
      hasQR: !!currentQR,
      error: botError,
      isInitializing,
      dbAvailable
    }
  });
});

app.get("/api/qr", async (req, res) => {
  try {
    if (!currentQR) {
      return res.json({ 
        success: true, 
        hasQR: false, 
        connected: botReady,
        isInitializing,
        error: botError
      });
    }
    const qrDataUrl = await QRCode.toDataURL(currentQR);
    res.json({ 
      success: true, 
      hasQR: true, 
      qrCode: qrDataUrl,
      connected: botReady
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const apiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'API key required. Include X-API-Key header or api_key query parameter.' });
  }
  
  const keyData = await validateApiKey(apiKey);
  if (!keyData) {
    return res.status(401).json({ success: false, error: 'Invalid or inactive API key.' });
  }
  
  req.apiKeyData = keyData;
  next();
};

app.post("/api/keys/generate", async (req, res) => {
  try {
    const { name, permissions } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'Key name is required' });
    }
    
    if (!dbAvailable) {
      const dbError = !process.env.DATABASE_URL 
        ? 'DATABASE_URL environment variable is not set. Please add your PostgreSQL database URL.'
        : 'Database connection failed. Please check your DATABASE_URL and ensure the database is accessible.';
      return res.status(500).json({ success: false, error: dbError, dbStatus: 'unavailable' });
    }
    
    const keyData = await createApiKey(name, permissions || 'read,write');
    if (!keyData) {
      return res.status(500).json({ success: false, error: 'Failed to create API key. Please try again or check database logs.' });
    }
    
    res.json({ 
      success: true, 
      message: 'API key created successfully. Save this key securely - it will only be shown once!',
      key: {
        id: keyData.key_id,
        api_key: keyData.api_key,
        name: keyData.name,
        permissions: keyData.permissions
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/keys", async (req, res) => {
  try {
    const keys = await getApiKeys();
    res.json({ success: true, keys });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/keys/:keyId", async (req, res) => {
  try {
    const { keyId } = req.params;
    const deleted = await deleteApiKey(keyId);
    if (deleted) {
      res.json({ success: true, message: 'API key deleted' });
    } else {
      res.status(404).json({ success: false, error: 'API key not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/keys/:keyId/revoke", async (req, res) => {
  try {
    const { keyId } = req.params;
    const revoked = await revokeApiKey(keyId);
    if (revoked) {
      res.json({ success: true, message: 'API key revoked' });
    } else {
      res.status(404).json({ success: false, error: 'API key not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/send", apiKeyAuth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: 'Phone and message are required' });
    }
    
    if (!botReady) {
      return res.status(503).json({ success: false, error: 'WhatsApp bot is not connected' });
    }
    
    const jid = formatPhone(phone);
    if (!jid) {
      return res.status(400).json({ success: false, error: 'Invalid phone number format' });
    }
    
    await safeSend(jid, message);
    res.json({ success: true, message: 'Message sent successfully', to: jid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/send-bulk", apiKeyAuth, async (req, res) => {
  try {
    const { phones, message } = req.body;
    
    if (!phones || !Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({ success: false, error: 'Phones array is required' });
    }
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    if (!botReady) {
      return res.status(503).json({ success: false, error: 'WhatsApp bot is not connected' });
    }
    
    let sent = 0;
    let failed = 0;
    const results = [];
    
    for (const phone of phones) {
      const jid = formatPhone(phone);
      if (jid) {
        try {
          await safeSend(jid, message);
          sent++;
          results.push({ phone, status: 'sent' });
        } catch (e) {
          failed++;
          results.push({ phone, status: 'failed', error: e.message });
        }
      } else {
        failed++;
        results.push({ phone, status: 'failed', error: 'Invalid phone format' });
      }
    }
    
    res.json({ success: true, sent, failed, total: phones.length, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/status", apiKeyAuth, (req, res) => {
  res.json({
    success: true,
    bot: {
      connected: botReady,
      uptime: process.uptime(),
      totalUsers: Object.keys(users).length
    }
  });
});

app.get("/api/v1/users", apiKeyAuth, (req, res) => {
  const userList = Object.entries(users).map(([jid, u]) => ({
    phone: u.phone,
    name: u.name,
    balance: u.balance,
    messageCount: u.messageCount,
    banned: u.banned
  }));
  res.json({ success: true, users: userList });
});

function parseContactsFromFile(buffer, filename) {
  const content = buffer.toString('utf-8');
  const ext = path.extname(filename).toLowerCase();
  const phones = [];
  
  if (ext === '.csv' || ext === '.txt') {
    const lines = content.split(/[\r\n]+/).filter(l => l.trim());
    for (const line of lines) {
      const parts = line.split(/[,;\t|]+/);
      for (const part of parts) {
        const cleaned = part.replace(/[^0-9+]/g, '');
        if (cleaned.length >= 9) {
          phones.push(cleaned);
        }
      }
    }
  } else if (ext === '.vcf') {
    const telMatches = content.match(/TEL[^:]*:([^\r\n]+)/gi) || [];
    for (const match of telMatches) {
      const num = match.split(':')[1]?.replace(/[^0-9+]/g, '');
      if (num && num.length >= 9) phones.push(num);
    }
  } else if (ext === '.json') {
    try {
      const data = JSON.parse(content);
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        const phone = item.phone || item.number || item.tel || item.mobile;
        if (phone) {
          const cleaned = String(phone).replace(/[^0-9+]/g, '');
          if (cleaned.length >= 9) phones.push(cleaned);
        }
      }
    } catch {}
  }
  
  return [...new Set(phones)];
}

app.post("/api/recipients/upload", upload.single('file'), (req, res) => {
  try {
    const { userPhone } = req.body;
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    
    let jid = userPhone?.includes('@c.us') ? userPhone : userPhone + '@c.us';
    if (!jid.startsWith('254') && !jid.includes('@')) {
      jid = '254' + jid.replace(/^0/, '') + '@c.us';
    }
    
    if (!users[jid]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const phones = parseContactsFromFile(req.file.buffer, req.file.originalname);
    
    if (phones.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid phone numbers found in file' });
    }
    
    let added = 0;
    for (const phone of phones) {
      const formatted = formatPhone(phone);
      if (formatted && !users[jid].recipients.includes(formatted)) {
        users[jid].recipients.push(formatted);
        added++;
      }
    }
    
    saveUsers(users);
    res.json({ success: true, added, total: users[jid].recipients.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/maintenance/toggle", async (req, res) => {
  try {
    const current = isMaintenanceMode();
    await setSetting('maintenanceMode', current ? 'false' : 'true');
    botSettings.maintenanceMode = current ? 'false' : 'true';
    res.json({ success: true, maintenanceMode: !current });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/features/toggle", async (req, res) => {
  try {
    const { feature } = req.body;
    const validFeatures = ['featureReferrals', 'featureTemplates', 'featureAnalytics', 'featureVIP', 'featureScheduledMsgs'];
    if (!validFeatures.includes(feature)) {
      return res.status(400).json({ success: false, error: 'Invalid feature' });
    }
    const current = isFeatureEnabled(feature);
    await setSetting(feature, current ? 'false' : 'true');
    botSettings[feature] = current ? 'false' : 'true';
    res.json({ success: true, [feature]: !current });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/transactions", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const transactions = await getTransactions(limit);
    res.json({ success: true, transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const stats = await getTransactionStats();
    res.json({
      success: true,
      stats: {
        ...stats,
        totalUsers: Object.keys(users).length,
        botReady,
        uptime: process.uptime(),
        maintenanceMode: isMaintenanceMode(),
        features: {
          referrals: isFeatureEnabled('featureReferrals'),
          templates: isFeatureEnabled('featureTemplates'),
          analytics: isFeatureEnabled('featureAnalytics'),
          vip: isFeatureEnabled('featureVIP'),
          scheduledMsgs: isFeatureEnabled('featureScheduledMsgs')
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", async (req, res) => {
  let qrImgData = "";
  if (currentQR) {
    try { qrImgData = await QRCode.toDataURL(currentQR); } catch {}
  }

  let totalUsers = 0;
  let stats = { total: 0, completed: 0, pending: 0, failed: 0, total_deposits: 0 };
  let recentTxns = [];
  
  try {
    totalUsers = Object.keys(users).length;
    stats = await getTransactionStats();
    recentTxns = await getTransactions(10);
    await loadBotSettings();
  } catch (err) {
    console.error('Dashboard data error:', err.message);
  }

  const apiConfigured = config.apiKey && config.apiSecret;
  const botName = getBotName();

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <title>${botName} - Admin Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    :root {
      --primary: #667eea;
      --primary-dark: #5a67d8;
      --secondary: #764ba2;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --dark: #1f2937;
      --light: #f3f4f6;
      --gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #fff;
    }
    .navbar {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(20px);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      flex-wrap: wrap;
      gap: 1rem;
    }
    .navbar h1 {
      font-size: 1.5rem;
      background: var(--gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-weight: 800;
    }
    .navbar .nav-links {
      display: flex;
      gap: 1rem;
    }
    .navbar .nav-links a {
      color: rgba(255,255,255,0.8);
      text-decoration: none;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      transition: all 0.3s;
    }
    .navbar .nav-links a:hover, .navbar .nav-links a.active {
      background: rgba(255,255,255,0.1);
      color: #fff;
    }
    .navbar .status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: ${botReady ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)'};
      border-radius: 50px;
      font-size: 0.9rem;
    }
    .navbar .status::before {
      content: '';
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${botReady ? '#10b981' : '#f59e0b'};
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }
    .container { padding: 2rem; max-width: 1400px; margin: 0 auto; }
    .tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .tab {
      padding: 0.75rem 1.5rem;
      background: rgba(255,255,255,0.1);
      border: none;
      border-radius: 10px;
      color: #fff;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: 500;
    }
    .tab:hover, .tab.active {
      background: var(--gradient);
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .alert {
      padding: 1rem 1.5rem;
      border-radius: 12px;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .alert.warning {
      background: rgba(245,158,11,0.2);
      border: 1px solid #f59e0b;
    }
    .alert.success {
      background: rgba(16,185,129,0.2);
      border: 1px solid #10b981;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 1.5rem;
      border: 1px solid rgba(255,255,255,0.1);
      transition: transform 0.3s, box-shadow 0.3s;
    }
    .stat-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 20px 40px rgba(0,0,0,0.3);
    }
    .stat-card .icon {
      width: 50px;
      height: 50px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      margin-bottom: 1rem;
    }
    .stat-card.users .icon { background: linear-gradient(135deg, #667eea, #764ba2); }
    .stat-card.deposits .icon { background: linear-gradient(135deg, #10b981, #059669); }
    .stat-card.pending .icon { background: linear-gradient(135deg, #f59e0b, #d97706); }
    .stat-card.failed .icon { background: linear-gradient(135deg, #ef4444, #dc2626); }
    .stat-card h3 { font-size: 0.9rem; color: rgba(255,255,255,0.7); margin-bottom: 0.5rem; }
    .stat-card .value { font-size: 1.8rem; font-weight: 700; }
    .stat-card .sub { font-size: 0.8rem; color: rgba(255,255,255,0.5); margin-top: 0.5rem; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 2rem; }
    .card {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.1);
      overflow: hidden;
    }
    .card-header {
      padding: 1.5rem;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-header h2 { font-size: 1.2rem; font-weight: 600; }
    .card-body { padding: 1.5rem; }
    .qr-section { text-align: center; padding: 2rem; }
    .qr-section img {
      max-width: 250px;
      border-radius: 15px;
      background: #fff;
      padding: 1rem;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    .qr-section .connected { color: var(--success); font-size: 1.5rem; font-weight: 600; }
    .qr-section .connected i { margin-right: 0.5rem; }
    .qr-loading { text-align: center; }
    .spinner {
      width: 50px;
      height: 50px;
      border: 4px solid rgba(255,255,255,0.2);
      border-top: 4px solid var(--primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .form-group {
      margin-bottom: 1.5rem;
    }
    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      color: rgba(255,255,255,0.8);
    }
    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      padding: 0.75rem 1rem;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 10px;
      color: #fff;
      font-size: 1rem;
      font-family: inherit;
    }
    .form-group textarea {
      min-height: 120px;
      resize: vertical;
    }
    .form-group input:focus, .form-group textarea:focus {
      outline: none;
      border-color: var(--primary);
    }
    .btn {
      padding: 0.75rem 1.5rem;
      border: none;
      border-radius: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.3s, box-shadow 0.3s;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      text-decoration: none;
      font-size: 0.9rem;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
    }
    .btn-primary { background: var(--gradient); color: #fff; }
    .btn-success { background: var(--success); color: #fff; }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-sm { padding: 0.5rem 1rem; font-size: 0.85rem; }
    .txn-table { width: 100%; border-collapse: collapse; }
    .txn-table th, .txn-table td {
      padding: 1rem;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .txn-table th { font-weight: 600; font-size: 0.85rem; color: rgba(255,255,255,0.7); text-transform: uppercase; }
    .txn-table tr:hover { background: rgba(255,255,255,0.05); }
    .badge { padding: 0.35rem 0.75rem; border-radius: 50px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
    .badge.completed { background: rgba(16,185,129,0.2); color: #10b981; }
    .badge.pending { background: rgba(245,158,11,0.2); color: #f59e0b; }
    .badge.failed { background: rgba(239,68,68,0.2); color: #ef4444; }
    .badge.active { background: rgba(16,185,129,0.2); color: #10b981; }
    .badge.banned { background: rgba(239,68,68,0.2); color: #ef4444; }
    .user-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1rem;
      margin-bottom: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .user-info h4 { font-size: 1rem; margin-bottom: 0.25rem; }
    .user-info p { font-size: 0.85rem; color: rgba(255,255,255,0.6); }
    .user-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      padding: 1rem 1.5rem;
      border-radius: 10px;
      background: var(--success);
      color: #fff;
      font-weight: 500;
      z-index: 1000;
      animation: slideIn 0.3s ease;
      display: none;
    }
    .toast.error { background: var(--danger); }
    .toast.show { display: block; }
    @keyframes slideIn {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .setting-item {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1rem;
    }
    .setting-item h3 {
      font-size: 1rem;
      margin-bottom: 0.5rem;
      color: rgba(255,255,255,0.9);
    }
    .setting-item p {
      font-size: 0.85rem;
      color: rgba(255,255,255,0.6);
      margin-bottom: 1rem;
    }
    @media (max-width: 768px) {
      .container { padding: 1rem; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .grid-2 { grid-template-columns: 1fr; }
      .navbar h1 { font-size: 1.2rem; }
      .tabs { overflow-x: auto; flex-wrap: nowrap; }
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <h1><i class="fas fa-robot"></i> ${botName} Dashboard</h1>
    <div class="status">${botReady ? 'Bot Online' : 'Connecting...'}</div>
  </nav>
  
  <div class="container">
    <div class="tabs">
      <button class="tab active" onclick="showTab('dashboard')"><i class="fas fa-chart-line"></i> Dashboard</button>
      <button class="tab" onclick="showTab('users')"><i class="fas fa-users"></i> Users</button>
      <button class="tab" onclick="showTab('settings')"><i class="fas fa-cog"></i> Bot Settings</button>
      <button class="tab" onclick="showTab('broadcast')"><i class="fas fa-bullhorn"></i> Broadcast</button>
      <button class="tab" onclick="showTab('transactions')"><i class="fas fa-exchange-alt"></i> Transactions</button>
      <button class="tab" onclick="showTab('api')"><i class="fas fa-key"></i> API</button>
    </div>

    <!-- Dashboard Tab -->
    <div id="dashboard" class="tab-content active">
      ${!apiConfigured ? `
      <div class="alert warning">
        <i class="fas fa-exclamation-triangle"></i>
        <div>
          <strong>API Configuration Required</strong>
          <p>Set your Shadow Payment Gateway credentials using environment variables.</p>
        </div>
      </div>
      ` : `
      <div class="alert success">
        <i class="fas fa-check-circle"></i>
        <div>
          <strong>API Configured</strong>
          <p>Shadow Payment Gateway is connected and ready.</p>
        </div>
      </div>
      `}

      <div class="stats-grid">
        <div class="stat-card users">
          <div class="icon"><i class="fas fa-users"></i></div>
          <h3>Total Users</h3>
          <div class="value">${totalUsers}</div>
          <div class="sub">Registered accounts</div>
        </div>
        <div class="stat-card deposits">
          <div class="icon"><i class="fas fa-coins"></i></div>
          <h3>Total Deposits</h3>
          <div class="value">Ksh ${parseFloat(stats.total_deposits || 0).toFixed(2)}</div>
          <div class="sub">${stats.completed || 0} successful</div>
        </div>
        <div class="stat-card pending">
          <div class="icon"><i class="fas fa-clock"></i></div>
          <h3>Pending</h3>
          <div class="value">${stats.pending || 0}</div>
          <div class="sub">Awaiting confirmation</div>
        </div>
        <div class="stat-card failed">
          <div class="icon"><i class="fas fa-times-circle"></i></div>
          <h3>Failed</h3>
          <div class="value">${stats.failed || 0}</div>
          <div class="sub">Unsuccessful attempts</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-header">
            <h2><i class="fas fa-qrcode"></i> WhatsApp Connection</h2>
          </div>
          <div class="card-body qr-section" id="qr-container">
            ${qrImgData ?
              `<img id="qr-image" src="${qrImgData}" alt="Scan QR Code"><p style="margin-top:1rem;color:rgba(255,255,255,0.7);">Scan with WhatsApp to connect</p>` :
              botReady ?
                `<div class="connected"><i class="fas fa-check-circle"></i> Connected!</div><p style="margin-top:1rem;color:rgba(255,255,255,0.7);">Bot is running and ready</p>` :
                `<div class="qr-loading"><div class="spinner"></div><p style="color:rgba(255,255,255,0.7);">Waiting for QR code...</p><p style="margin-top:0.5rem;color:rgba(245,158,11,0.8);font-size:0.9rem;">Loading may take 1-2 minutes</p></div>`
            }
            <div id="qr-buttons" style="margin-top:1.5rem;display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
              ${botReady ? 
                `<button class="btn btn-danger btn-sm" onclick="logoutWhatsApp()"><i class="fas fa-sign-out-alt"></i> Logout & Re-scan</button>` :
                `<button class="btn btn-primary btn-sm" onclick="reconnectWhatsApp()"><i class="fas fa-sync"></i> Reconnect</button>`
              }
              <button class="btn btn-sm" style="background:rgba(255,255,255,0.1);" onclick="location.reload()"><i class="fas fa-redo"></i> Refresh</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2><i class="fas fa-history"></i> Recent Transactions</h2>
          </div>
          <div class="card-body" style="max-height: 400px; overflow-y: auto;">
            ${recentTxns.length === 0 ? '<p style="text-align:center;color:rgba(255,255,255,0.5);">No transactions yet</p>' : `
            <table class="txn-table">
              <thead><tr><th>User</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                ${recentTxns.map(t => `
                  <tr>
                    <td>${t.user_name || 'N/A'}<br><small style="color:rgba(255,255,255,0.5)">${t.phone}</small></td>
                    <td>Ksh ${parseFloat(t.amount || 0).toFixed(2)}</td>
                    <td><span class="badge ${t.status}">${t.status}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            `}
          </div>
        </div>
      </div>
    </div>

    <!-- Users Tab -->
    <div id="users" class="tab-content">
      <div class="card">
        <div class="card-header">
          <h2><i class="fas fa-users"></i> All Users</h2>
          <button class="btn btn-primary btn-sm" onclick="refreshUsers()"><i class="fas fa-sync"></i> Refresh</button>
        </div>
        <div class="card-body" id="users-list">
          ${Object.entries(users).map(([jid, u]) => `
            <div class="user-card">
              <div class="user-info">
                <h4>${u.name} <span class="badge ${u.banned ? 'banned' : 'active'}">${u.banned ? 'Banned' : 'Active'}</span></h4>
                <p>📱 ${u.phone} | 💰 Ksh ${u.balance?.toFixed(2) || '0.00'} | 📤 ${u.messageCount || 0} msgs | 👥 ${u.recipients?.length || 0} recipients</p>
              </div>
              <div class="user-actions">
                <button class="btn btn-success btn-sm" onclick="modifyBalance('${u.phone}', 'add')"><i class="fas fa-plus"></i> Add Balance</button>
                <button class="btn btn-danger btn-sm" onclick="toggleBan('${u.phone}', ${u.banned})">${u.banned ? 'Unban' : 'Ban'}</button>
              </div>
            </div>
          `).join('') || '<p style="text-align:center;color:rgba(255,255,255,0.5);">No users registered yet</p>'}
        </div>
      </div>
    </div>

    <!-- Settings Tab -->
    <div id="settings" class="tab-content">
      <div class="card">
        <div class="card-header">
          <h2><i class="fas fa-cog"></i> Bot Settings</h2>
          <button class="btn btn-success btn-sm" onclick="saveAllSettings()"><i class="fas fa-save"></i> Save All</button>
        </div>
        <div class="card-body">
          <div class="setting-item">
            <h3><i class="fas fa-signature"></i> Bot Name</h3>
            <p>The name displayed throughout the bot and dashboard</p>
            <input type="text" id="setting-botName" value="${escapeHtml(botSettings.botName || DEFAULT_SETTINGS.botName)}">
          </div>
          
          <div class="setting-item">
            <h3><i class="fas fa-user-tie"></i> Admin Label (From Name)</h3>
            <p>Name shown when broadcasting messages</p>
            <input type="text" id="setting-fromAdmin" value="${escapeHtml(botSettings.fromAdmin || config.fromAdmin)}">
          </div>
          
          <div class="setting-item">
            <h3><i class="fas fa-dollar-sign"></i> Cost Per Character</h3>
            <p>Amount charged per character in broadcasts</p>
            <input type="number" step="0.001" id="setting-costPerChar" value="${botSettings.costPerChar || config.costPerChar}">
          </div>
          
          <div class="setting-item">
            <h3><i class="fas fa-hand-wave"></i> Welcome Text</h3>
            <p>Message shown to new users</p>
            <textarea id="setting-welcomeText">${escapeHtml(botSettings.welcomeText || DEFAULT_SETTINGS.welcomeText)}</textarea>
          </div>
          
          <div class="setting-item">
            <h3><i class="fas fa-headset"></i> Support Text</h3>
            <p>Contact support message</p>
            <textarea id="setting-supportText">${escapeHtml(botSettings.supportText || DEFAULT_SETTINGS.supportText)}</textarea>
          </div>
          
          <div class="setting-item">
            <h3><i class="fas fa-wallet"></i> Top-up Prompt</h3>
            <p>Message shown when user wants to top-up</p>
            <textarea id="setting-topupPrompt">${escapeHtml(botSettings.topupPrompt || DEFAULT_SETTINGS.topupPrompt)}</textarea>
          </div>
          
          <div class="setting-item">
            <h3><i class="fas fa-check-circle"></i> Registration Success</h3>
            <p>Message after successful registration. Use {name} for username</p>
            <textarea id="setting-regSuccessTemplate">${escapeHtml(botSettings.regSuccessTemplate || DEFAULT_SETTINGS.regSuccessTemplate)}</textarea>
          </div>
          
          <div class="setting-item">
            <h3><i class="fas fa-exclamation-triangle"></i> Insufficient Balance Message</h3>
            <p>Shown when user doesn't have enough balance. Use {cost}, {balance}, {shortfall}</p>
            <textarea id="setting-notEnoughBalTemplate">${escapeHtml(botSettings.notEnoughBalTemplate || DEFAULT_SETTINGS.notEnoughBalTemplate)}</textarea>
          </div>
        </div>
      </div>
    </div>

    <!-- Broadcast Tab -->
    <div id="broadcast" class="tab-content">
      <div class="card">
        <div class="card-header">
          <h2><i class="fas fa-bullhorn"></i> Broadcast Message</h2>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label>Message to broadcast to all users</label>
            <textarea id="broadcast-message" placeholder="Type your broadcast message here..."></textarea>
          </div>
          <button class="btn btn-primary" onclick="sendBroadcast()"><i class="fas fa-paper-plane"></i> Send Broadcast</button>
          <p style="margin-top: 1rem; color: rgba(255,255,255,0.6);">This will send a message to all ${totalUsers} registered users.</p>
        </div>
      </div>
    </div>

    <!-- Transactions Tab -->
    <div id="transactions" class="tab-content">
      <div class="card">
        <div class="card-header">
          <h2><i class="fas fa-exchange-alt"></i> All Transactions</h2>
          <button class="btn btn-primary btn-sm" onclick="refreshTransactions()"><i class="fas fa-sync"></i> Refresh</button>
        </div>
        <div class="card-body" id="transactions-list" style="max-height: 600px; overflow-y: auto;">
          ${recentTxns.length === 0 ? '<p style="text-align:center;color:rgba(255,255,255,0.5);">No transactions yet</p>' : `
          <table class="txn-table">
            <thead><tr><th>Reference</th><th>User</th><th>Phone</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              ${recentTxns.map(t => `
                <tr>
                  <td><code>${t.reference}</code></td>
                  <td>${t.user_name || 'N/A'}</td>
                  <td>${t.phone}</td>
                  <td>Ksh ${parseFloat(t.amount || 0).toFixed(2)}</td>
                  <td><span class="badge ${t.status}">${t.status}</span></td>
                  <td>${new Date(t.created_at).toLocaleString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          `}
        </div>
      </div>
    </div>

    <!-- API Tab -->
    <div id="api" class="tab-content">
      <div class="card" style="margin-bottom: 2rem;">
        <div class="card-header">
          <h2><i class="fas fa-key"></i> API Keys</h2>
        </div>
        <div class="card-body">
          <div class="setting-item">
            <h3><i class="fas fa-plus-circle"></i> Generate New API Key</h3>
            <p>Create a new API key for external integrations</p>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:1rem;">
              <input type="text" id="api-key-name" placeholder="Key name (e.g., PHP Backend)" style="flex:1;min-width:200px;">
              <button class="btn btn-primary" onclick="generateApiKey()"><i class="fas fa-key"></i> Generate Key</button>
            </div>
          </div>
          
          <div id="generated-key-display" style="display:none;background:rgba(16,185,129,0.1);border:1px solid #10b981;padding:1rem;border-radius:10px;margin:1rem 0;">
            <p style="color:#10b981;font-weight:600;margin-bottom:0.5rem;"><i class="fas fa-check-circle"></i> API Key Generated!</p>
            <p style="color:rgba(245,158,11,0.9);font-size:0.85rem;margin-bottom:0.5rem;">Copy this key now - it won't be shown again!</p>
            <code id="new-api-key" style="display:block;background:rgba(0,0,0,0.3);padding:0.75rem;border-radius:6px;word-break:break-all;font-size:0.9rem;"></code>
            <button class="btn btn-sm" style="margin-top:0.5rem;background:rgba(255,255,255,0.1);" onclick="copyApiKey()"><i class="fas fa-copy"></i> Copy Key</button>
          </div>
          
          <div id="api-keys-list" style="margin-top:1.5rem;">
            <h3 style="margin-bottom:1rem;"><i class="fas fa-list"></i> Your API Keys</h3>
            <p style="color:rgba(255,255,255,0.5);">Loading keys...</p>
          </div>
        </div>
      </div>
      
      <div class="card">
        <div class="card-header">
          <h2><i class="fas fa-book"></i> API Documentation</h2>
        </div>
        <div class="card-body">
          <p style="margin-bottom:1rem;">Full API documentation with code examples for PHP, Python, Node.js, and more.</p>
          <a href="/docs" class="btn btn-primary" target="_blank"><i class="fas fa-external-link-alt"></i> View API Documentation</a>
        </div>
      </div>
      
      <!-- API Tester Section -->
      <div class="card" style="margin-top: 2rem;">
        <div class="card-header">
          <h2><i class="fas fa-flask"></i> API Tester</h2>
        </div>
        <div class="card-body">
          <p style="margin-bottom:1rem;color:rgba(255,255,255,0.7);">Test your API endpoints directly from the dashboard.</p>
          
          <div style="display:grid;gap:1rem;margin-bottom:1rem;">
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
              <select id="api-test-method" style="padding:0.75rem;border-radius:8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;font-weight:600;">
                <option value="GET">GET</option>
                <option value="POST" selected>POST</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
              <input type="text" id="api-test-endpoint" placeholder="/api/initiate-payment" style="flex:1;min-width:250px;padding:0.75rem;border-radius:8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;">
            </div>
            
            <div>
              <label style="display:block;margin-bottom:0.5rem;color:rgba(255,255,255,0.7);font-size:0.9rem;">Headers (JSON)</label>
              <textarea id="api-test-headers" placeholder='{"Content-Type": "application/json", "X-API-Key": "your-key"}' style="width:100%;height:60px;padding:0.75rem;border-radius:8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;font-family:monospace;font-size:0.85rem;resize:vertical;">{"Content-Type": "application/json"}</textarea>
            </div>
            
            <div>
              <label style="display:block;margin-bottom:0.5rem;color:rgba(255,255,255,0.7);font-size:0.9rem;">Request Body (JSON)</label>
              <textarea id="api-test-body" placeholder='{"phone": "254712345678", "amount": 100}' style="width:100%;height:100px;padding:0.75rem;border-radius:8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;font-family:monospace;font-size:0.85rem;resize:vertical;"></textarea>
            </div>
            
            <button class="btn btn-primary" onclick="testApiEndpoint()" id="api-test-btn">
              <i class="fas fa-play"></i> Send Request
            </button>
          </div>
          
          <div id="api-test-result" style="display:none;background:rgba(0,0,0,0.3);border-radius:10px;padding:1rem;margin-top:1rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
              <span id="api-test-status" style="font-weight:600;"></span>
              <span id="api-test-time" style="font-size:0.85rem;color:rgba(255,255,255,0.6);"></span>
            </div>
            <pre id="api-test-response" style="background:rgba(0,0,0,0.3);padding:1rem;border-radius:8px;overflow-x:auto;font-size:0.85rem;max-height:300px;overflow-y:auto;margin:0;"></pre>
          </div>
        </div>
      </div>
      
      <!-- API Logs Viewer Section -->
      <div class="card" style="margin-top: 2rem;">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;">
          <h2><i class="fas fa-history"></i> API Logs</h2>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            <select id="api-logs-filter-method" onchange="loadApiLogs()" style="padding:0.5rem;border-radius:6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:0.85rem;">
              <option value="">All Methods</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
            </select>
            <select id="api-logs-filter-status" onchange="loadApiLogs()" style="padding:0.5rem;border-radius:6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:0.85rem;">
              <option value="">All Status</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
            </select>
            <button class="btn btn-sm" onclick="loadApiLogs()" style="background:rgba(255,255,255,0.1);"><i class="fas fa-sync"></i> Refresh</button>
            <button class="btn btn-sm" onclick="clearApiLogs()" style="background:rgba(239,68,68,0.3);"><i class="fas fa-trash"></i> Clear</button>
          </div>
        </div>
        <div class="card-body">
          <div id="api-logs-stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin-bottom:1rem;"></div>
          <div id="api-logs-container" style="max-height:400px;overflow-y:auto;">
            <p style="color:rgba(255,255,255,0.5);text-align:center;padding:2rem;">Loading logs...</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function showTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      event.target.classList.add('active');
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => toast.className = 'toast', 3000);
    }

    async function saveAllSettings() {
      const settings = {
        botName: document.getElementById('setting-botName').value,
        fromAdmin: document.getElementById('setting-fromAdmin').value,
        costPerChar: document.getElementById('setting-costPerChar').value,
        welcomeText: document.getElementById('setting-welcomeText').value,
        supportText: document.getElementById('setting-supportText').value,
        topupPrompt: document.getElementById('setting-topupPrompt').value,
        regSuccessTemplate: document.getElementById('setting-regSuccessTemplate').value,
        notEnoughBalTemplate: document.getElementById('setting-notEnoughBalTemplate').value
      };

      try {
        const res = await fetch('/api/settings/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Settings saved successfully!');
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error saving settings', true);
      }
    }

    async function sendBroadcast() {
      const message = document.getElementById('broadcast-message').value;
      if (!message.trim()) {
        showToast('Please enter a message', true);
        return;
      }

      try {
        const res = await fetch('/api/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Broadcast sent to ' + data.sent + ' users!');
          document.getElementById('broadcast-message').value = '';
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error sending broadcast', true);
      }
    }

    async function modifyBalance(phone, operation) {
      const amount = prompt('Enter amount:');
      if (!amount || isNaN(amount)) return;

      try {
        const res = await fetch('/api/users/' + phone + '/balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: parseFloat(amount), operation })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Balance updated! New balance: Ksh ' + data.newBalance.toFixed(2));
          setTimeout(() => location.reload(), 1500);
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error updating balance', true);
      }
    }

    async function toggleBan(phone, currentlyBanned) {
      let reason = '';
      if (!currentlyBanned) {
        reason = prompt('Enter ban reason:');
        if (reason === null) return;
      }

      try {
        const res = await fetch('/api/users/' + phone + '/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ban: !currentlyBanned, reason })
        });
        const data = await res.json();
        if (data.success) {
          showToast(currentlyBanned ? 'User unbanned!' : 'User banned!');
          setTimeout(() => location.reload(), 1500);
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error updating ban status', true);
      }
    }

    function refreshUsers() {
      location.reload();
    }

    function refreshTransactions() {
      location.reload();
    }

    async function logoutWhatsApp() {
      if (!confirm('Are you sure you want to logout? You will need to scan a new QR code to reconnect.')) return;
      
      showToast('Logging out...', false);
      try {
        const res = await fetch('/api/whatsapp/logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Logged out! Refresh page to scan new QR code.');
          setTimeout(() => location.reload(), 2000);
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error logging out', true);
      }
    }

    async function reconnectWhatsApp() {
      showToast('Reconnecting WhatsApp...', false);
      try {
        const res = await fetch('/api/whatsapp/reconnect', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Reconnection initiated! Please wait...');
          setTimeout(() => location.reload(), 5000);
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error reconnecting', true);
      }
    }

    async function generateApiKey() {
      const name = document.getElementById('api-key-name').value.trim();
      if (!name) {
        showToast('Please enter a key name', true);
        return;
      }

      try {
        const res = await fetch('/api/keys/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('new-api-key').textContent = data.key.api_key;
          document.getElementById('generated-key-display').style.display = 'block';
          document.getElementById('api-key-name').value = '';
          loadApiKeys();
          showToast('API key generated successfully!');
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error generating API key', true);
      }
    }

    function copyApiKey() {
      const key = document.getElementById('new-api-key').textContent;
      navigator.clipboard.writeText(key).then(() => {
        showToast('API key copied to clipboard!');
      }).catch(() => {
        showToast('Failed to copy', true);
      });
    }

    async function loadApiKeys() {
      try {
        const res = await fetch('/api/keys');
        const data = await res.json();
        const container = document.getElementById('api-keys-list');
        
        if (data.success && data.keys.length > 0) {
          container.innerHTML = '<h3 style="margin-bottom:1rem;"><i class="fas fa-list"></i> Your API Keys</h3>' +
            data.keys.map(k => 
              '<div style="background:rgba(255,255,255,0.05);padding:1rem;border-radius:8px;margin-bottom:0.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">' +
                '<div>' +
                  '<strong>' + k.name + '</strong> ' +
                  '<span class="badge ' + (k.is_active ? 'active' : 'failed') + '">' + (k.is_active ? 'Active' : 'Revoked') + '</span>' +
                  '<br><small style="color:rgba(255,255,255,0.5);">ID: ' + k.key_id + ' | Requests: ' + k.requests_count + '</small>' +
                '</div>' +
                '<div style="display:flex;gap:0.5rem;">' +
                  (k.is_active ? '<button class="btn btn-danger btn-sm" onclick="revokeApiKey(\\'' + k.key_id + '\\')"><i class="fas fa-ban"></i> Revoke</button>' : '') +
                  '<button class="btn btn-sm" style="background:rgba(255,255,255,0.1);" onclick="deleteApiKey(\\'' + k.key_id + '\\')"><i class="fas fa-trash"></i></button>' +
                '</div>' +
              '</div>'
            ).join('');
        } else {
          container.innerHTML = '<h3 style="margin-bottom:1rem;"><i class="fas fa-list"></i> Your API Keys</h3><p style="color:rgba(255,255,255,0.5);">No API keys yet. Generate one above to get started.</p>';
        }
      } catch (err) {
        console.error('Error loading API keys:', err);
      }
    }

    async function revokeApiKey(keyId) {
      if (!confirm('Are you sure you want to revoke this API key?')) return;
      try {
        const res = await fetch('/api/keys/' + keyId + '/revoke', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('API key revoked');
          loadApiKeys();
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error revoking key', true);
      }
    }

    async function deleteApiKey(keyId) {
      if (!confirm('Are you sure you want to delete this API key permanently?')) return;
      try {
        const res = await fetch('/api/keys/' + keyId, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          showToast('API key deleted');
          loadApiKeys();
        } else {
          showToast('Error: ' + data.error, true);
        }
      } catch (err) {
        showToast('Error deleting key', true);
      }
    }

    // API Tester Functions
    async function testApiEndpoint() {
      const method = document.getElementById('api-test-method').value;
      const endpoint = document.getElementById('api-test-endpoint').value.trim();
      const headersText = document.getElementById('api-test-headers').value.trim();
      const bodyText = document.getElementById('api-test-body').value.trim();
      const btn = document.getElementById('api-test-btn');
      const resultDiv = document.getElementById('api-test-result');
      
      if (!endpoint) {
        showToast('Please enter an API endpoint', true);
        return;
      }
      
      let headers = {};
      let body = null;
      
      try {
        if (headersText) headers = JSON.parse(headersText);
      } catch (e) {
        showToast('Invalid JSON in headers', true);
        return;
      }
      
      try {
        if (bodyText && method !== 'GET') body = JSON.parse(bodyText);
      } catch (e) {
        showToast('Invalid JSON in request body', true);
        return;
      }
      
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
      
      const startTime = Date.now();
      
      try {
        const fetchOptions = {
          method: method,
          headers: headers
        };
        
        if (body && method !== 'GET') {
          fetchOptions.body = JSON.stringify(body);
        }
        
        const res = await fetch(endpoint, fetchOptions);
        const duration = Date.now() - startTime;
        
        let responseData;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          responseData = await res.json();
        } else {
          responseData = await res.text();
        }
        
        resultDiv.style.display = 'block';
        document.getElementById('api-test-status').innerHTML = 
          '<span style="color:' + (res.ok ? '#10b981' : '#ef4444') + ';">' +
          '<i class="fas fa-' + (res.ok ? 'check-circle' : 'times-circle') + '"></i> ' +
          res.status + ' ' + res.statusText + '</span>';
        document.getElementById('api-test-time').textContent = duration + 'ms';
        document.getElementById('api-test-response').textContent = 
          typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2);
        
        loadApiLogs();
      } catch (err) {
        resultDiv.style.display = 'block';
        document.getElementById('api-test-status').innerHTML = 
          '<span style="color:#ef4444;"><i class="fas fa-times-circle"></i> Error</span>';
        document.getElementById('api-test-time').textContent = (Date.now() - startTime) + 'ms';
        document.getElementById('api-test-response').textContent = 'Request failed: ' + err.message;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play"></i> Send Request';
      }
    }

    // API Logs Functions
    async function loadApiLogs() {
      const methodFilter = document.getElementById('api-logs-filter-method')?.value || '';
      const statusFilter = document.getElementById('api-logs-filter-status')?.value || '';
      
      try {
        let url = '/api/logs?limit=100';
        if (methodFilter) url += '&method=' + methodFilter;
        if (statusFilter) url += '&status=' + statusFilter;
        
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.success) {
          const statsDiv = document.getElementById('api-logs-stats');
          const container = document.getElementById('api-logs-container');
          
          // Stats
          const successCount = data.logs.filter(l => l.success).length;
          const errorCount = data.logs.filter(l => !l.success).length;
          statsDiv.innerHTML = 
            '<div style="background:rgba(16,185,129,0.2);padding:0.75rem;border-radius:8px;text-align:center;">' +
              '<div style="font-size:1.25rem;font-weight:700;color:#10b981;">' + successCount + '</div>' +
              '<div style="font-size:0.75rem;color:rgba(255,255,255,0.6);">Success</div>' +
            '</div>' +
            '<div style="background:rgba(239,68,68,0.2);padding:0.75rem;border-radius:8px;text-align:center;">' +
              '<div style="font-size:1.25rem;font-weight:700;color:#ef4444;">' + errorCount + '</div>' +
              '<div style="font-size:0.75rem;color:rgba(255,255,255,0.6);">Errors</div>' +
            '</div>' +
            '<div style="background:rgba(102,126,234,0.2);padding:0.75rem;border-radius:8px;text-align:center;">' +
              '<div style="font-size:1.25rem;font-weight:700;color:#667eea;">' + data.total + '</div>' +
              '<div style="font-size:0.75rem;color:rgba(255,255,255,0.6);">Total</div>' +
            '</div>';
          
          if (data.logs.length === 0) {
            container.innerHTML = '<p style="color:rgba(255,255,255,0.5);text-align:center;padding:2rem;">No API logs yet. Make some API requests to see logs here.</p>';
          } else {
            container.innerHTML = data.logs.map(log => 
              '<div style="background:rgba(255,255,255,0.05);padding:0.75rem;border-radius:8px;margin-bottom:0.5rem;border-left:3px solid ' + (log.success ? '#10b981' : '#ef4444') + ';">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem;">' +
                  '<div>' +
                    '<span style="background:' + getMethodColor(log.method) + ';padding:0.2rem 0.5rem;border-radius:4px;font-size:0.75rem;font-weight:600;margin-right:0.5rem;">' + log.method + '</span>' +
                    '<code style="font-size:0.85rem;color:rgba(255,255,255,0.9);">' + escapeHtml(log.path) + '</code>' +
                  '</div>' +
                  '<div style="display:flex;gap:0.75rem;font-size:0.75rem;color:rgba(255,255,255,0.5);">' +
                    '<span><i class="fas fa-clock"></i> ' + log.duration + 'ms</span>' +
                    '<span style="color:' + (log.success ? '#10b981' : '#ef4444') + ';">' + log.status + '</span>' +
                  '</div>' +
                '</div>' +
                '<div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">' + formatLogTime(log.timestamp) + '</div>' +
                (log.requestBody ? '<details style="margin-top:0.5rem;"><summary style="cursor:pointer;font-size:0.8rem;color:rgba(255,255,255,0.6);">Request Body</summary><pre style="background:rgba(0,0,0,0.3);padding:0.5rem;border-radius:4px;font-size:0.75rem;margin-top:0.25rem;overflow-x:auto;">' + escapeHtml(JSON.stringify(log.requestBody, null, 2)) + '</pre></details>' : '') +
              '</div>'
            ).join('');
          }
        }
      } catch (err) {
        console.error('Error loading API logs:', err);
      }
    }
    
    function getMethodColor(method) {
      const colors = {
        'GET': 'rgba(16,185,129,0.3)',
        'POST': 'rgba(59,130,246,0.3)',
        'PUT': 'rgba(245,158,11,0.3)',
        'DELETE': 'rgba(239,68,68,0.3)',
        'PATCH': 'rgba(139,92,246,0.3)'
      };
      return colors[method] || 'rgba(255,255,255,0.1)';
    }
    
    function formatLogTime(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleString();
    }
    
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    async function clearApiLogs() {
      if (!confirm('Are you sure you want to clear all API logs?')) return;
      try {
        const res = await fetch('/api/logs/clear', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('API logs cleared');
          loadApiLogs();
        } else {
          showToast('Error clearing logs', true);
        }
      } catch (err) {
        showToast('Error clearing logs', true);
      }
    }

    loadApiKeys();
    loadApiLogs();

    let qrPollInterval = null;
    let lastQrState = { hasQR: ${!!currentQR}, connected: ${botReady} };
    
    async function pollQrCode() {
      try {
        const res = await fetch('/api/qr');
        const data = await res.json();
        
        if (!data.success) return;
        
        const container = document.getElementById('qr-container');
        const buttons = document.getElementById('qr-buttons');
        if (!container) return;
        
        if (data.connected && !lastQrState.connected) {
          container.innerHTML = '<div class="connected"><i class="fas fa-check-circle"></i> Connected!</div><p style="margin-top:1rem;color:rgba(255,255,255,0.7);">Bot is running and ready</p>';
          buttons.innerHTML = '<button class="btn btn-danger btn-sm" onclick="logoutWhatsApp()"><i class="fas fa-sign-out-alt"></i> Logout & Re-scan</button><button class="btn btn-sm" style="background:rgba(255,255,255,0.1);" onclick="location.reload()"><i class="fas fa-redo"></i> Refresh</button>';
          showToast('WhatsApp connected successfully!');
          stopQrPolling();
        } else if (data.hasQR && data.qrCode) {
          let img = document.getElementById('qr-image');
          if (!img) {
            container.innerHTML = '<img id="qr-image" alt="Scan QR Code"><p style="margin-top:1rem;color:rgba(255,255,255,0.7);">Scan with WhatsApp to connect</p>';
            img = document.getElementById('qr-image');
          }
          if (img && img.src !== data.qrCode) {
            img.src = data.qrCode;
          }
          buttons.innerHTML = '<button class="btn btn-primary btn-sm" onclick="reconnectWhatsApp()"><i class="fas fa-sync"></i> Reconnect</button><button class="btn btn-sm" style="background:rgba(255,255,255,0.1);" onclick="location.reload()"><i class="fas fa-redo"></i> Refresh</button>';
        } else if (!data.connected && !data.hasQR) {
          if (!container.querySelector('.spinner')) {
            container.innerHTML = '<div class="qr-loading"><div class="spinner"></div><p style="color:rgba(255,255,255,0.7);">Waiting for QR code...</p><p style="margin-top:0.5rem;color:rgba(245,158,11,0.8);font-size:0.9rem;">Loading may take 1-2 minutes</p></div>';
          }
        }
        
        lastQrState = { hasQR: data.hasQR, connected: data.connected };
      } catch (err) {
        console.log('QR poll error:', err);
      }
    }
    
    function startQrPolling() {
      if (qrPollInterval) return;
      qrPollInterval = setInterval(pollQrCode, 3000);
      pollQrCode();
    }
    
    function stopQrPolling() {
      if (qrPollInterval) {
        clearInterval(qrPollInterval);
        qrPollInterval = null;
      }
    }
    
    if (!${botReady}) {
      startQrPolling();
    }

    setInterval(() => {
      fetch('/keep-alive').catch(() => {});
    }, 240000);
  </script>
</body>
</html>
  `);
});

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

app.get("/docs", (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const BASE_URL = getBaseUrl(req);
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Documentation - FY'S PROPERTY Bot</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); min-height: 100vh; color: #fff; padding: 2rem; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 2.5rem; margin-bottom: 1rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    h2 { font-size: 1.5rem; margin: 2rem 0 1rem; color: #667eea; }
    h3 { font-size: 1.2rem; margin: 1.5rem 0 0.5rem; color: #10b981; }
    .intro { background: rgba(255,255,255,0.1); padding: 1.5rem; border-radius: 12px; margin-bottom: 2rem; }
    .endpoint { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .method { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 6px; font-weight: 600; font-size: 0.8rem; margin-right: 0.5rem; }
    .method.get { background: #10b981; }
    .method.post { background: #667eea; }
    .method.delete { background: #ef4444; }
    .url { font-family: monospace; background: rgba(0,0,0,0.3); padding: 0.5rem 1rem; border-radius: 6px; display: inline-block; margin-top: 0.5rem; }
    pre { background: rgba(0,0,0,0.4); padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 1rem 0; font-size: 0.85rem; }
    code { font-family: 'Fira Code', monospace; }
    .param { margin: 0.5rem 0; padding-left: 1rem; border-left: 3px solid #667eea; }
    .param strong { color: #f59e0b; }
    .back-btn { display: inline-block; padding: 0.75rem 1.5rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; text-decoration: none; color: #fff; margin-bottom: 2rem; }
    .tab-container { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .lang-tab { padding: 0.5rem 1rem; background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer; border-radius: 6px; }
    .lang-tab.active { background: #667eea; }
    .code-block { display: none; }
    .code-block.active { display: block; }
    .note { background: rgba(245,158,11,0.2); border: 1px solid rgba(245,158,11,0.5); padding: 1rem; border-radius: 8px; margin: 1rem 0; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back-btn"><i class="fas fa-arrow-left"></i> Back to Dashboard</a>
    <h1><i class="fas fa-book"></i> API Documentation</h1>
    
    <div class="intro">
      <h3>Getting Started</h3>
      <p>This API allows you to send WhatsApp messages programmatically from any language. All API requests require an API key for authentication.</p>
      <div class="note">
        <strong><i class="fas fa-key"></i> Authentication:</strong> Include your API key in the <code>X-API-Key</code> header or as <code>api_key</code> query parameter.
      </div>
      <p style="margin-top:1rem"><strong>Base URL:</strong> <code>${BASE_URL}</code></p>
    </div>

    <h2><i class="fas fa-paper-plane"></i> Send Single Message</h2>
    <div class="endpoint">
      <span class="method post">POST</span>
      <div class="url">/api/v1/send</div>
      <h3>Parameters (JSON Body)</h3>
      <div class="param"><strong>phone</strong> (required) - Recipient phone number (e.g., 254712345678)</div>
      <div class="param"><strong>message</strong> (required) - Message text to send</div>
      
      <h3>Code Examples</h3>
      <div class="tab-container">
        <button class="lang-tab active" onclick="showLang('send', 'php')">PHP</button>
        <button class="lang-tab" onclick="showLang('send', 'python')">Python</button>
        <button class="lang-tab" onclick="showLang('send', 'node')">Node.js</button>
        <button class="lang-tab" onclick="showLang('send', 'curl')">cURL</button>
      </div>
      
      <pre class="code-block active" id="send-php"><code>&lt;?php
$apiKey = 'YOUR_API_KEY';
$baseUrl = '${BASE_URL}';

$data = [
    'phone' => '254712345678',
    'message' => 'Hello from PHP!'
];

$ch = curl_init("$baseUrl/api/v1/send");
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'X-API-Key: ' . $apiKey
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

$response = curl_exec($ch);
curl_close($ch);

echo $response;
?&gt;</code></pre>

      <pre class="code-block" id="send-python"><code>import requests

api_key = 'YOUR_API_KEY'
base_url = '${BASE_URL}'

headers = {
    'Content-Type': 'application/json',
    'X-API-Key': api_key
}

data = {
    'phone': '254712345678',
    'message': 'Hello from Python!'
}

response = requests.post(
    f'{base_url}/api/v1/send',
    json=data,
    headers=headers
)

print(response.json())</code></pre>

      <pre class="code-block" id="send-node"><code>const axios = require('axios');

const apiKey = 'YOUR_API_KEY';
const baseUrl = '${BASE_URL}';

async function sendMessage() {
  try {
    const response = await axios.post(\`\${baseUrl}/api/v1/send\`, {
      phone: '254712345678',
      message: 'Hello from Node.js!'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      }
    });
    
    console.log(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);
  }
}

sendMessage();</code></pre>

      <pre class="code-block" id="send-curl"><code>curl -X POST "${BASE_URL}/api/v1/send" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{"phone": "254712345678", "message": "Hello from cURL!"}'</code></pre>
    </div>

    <h2><i class="fas fa-broadcast-tower"></i> Send Bulk Messages</h2>
    <div class="endpoint">
      <span class="method post">POST</span>
      <div class="url">/api/v1/send-bulk</div>
      <h3>Parameters (JSON Body)</h3>
      <div class="param"><strong>phones</strong> (required) - Array of phone numbers</div>
      <div class="param"><strong>message</strong> (required) - Message text to send</div>
      
      <h3>Code Examples</h3>
      <div class="tab-container">
        <button class="lang-tab active" onclick="showLang('bulk', 'php')">PHP</button>
        <button class="lang-tab" onclick="showLang('bulk', 'python')">Python</button>
        <button class="lang-tab" onclick="showLang('bulk', 'node')">Node.js</button>
      </div>
      
      <pre class="code-block active" id="bulk-php"><code>&lt;?php
$data = [
    'phones' => ['254712345678', '254787654321', '254700111222'],
    'message' => 'Bulk message from PHP!'
];

$ch = curl_init("${BASE_URL}/api/v1/send-bulk");
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'X-API-Key: YOUR_API_KEY'
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

$response = curl_exec($ch);
print_r(json_decode($response, true));
?&gt;</code></pre>

      <pre class="code-block" id="bulk-python"><code>import requests

response = requests.post(
    '${BASE_URL}/api/v1/send-bulk',
    json={
        'phones': ['254712345678', '254787654321'],
        'message': 'Bulk message from Python!'
    },
    headers={'X-API-Key': 'YOUR_API_KEY'}
)

result = response.json()
print(f"Sent: {result['sent']}, Failed: {result['failed']}")</code></pre>

      <pre class="code-block" id="bulk-node"><code>const response = await axios.post('${BASE_URL}/api/v1/send-bulk', {
  phones: ['254712345678', '254787654321'],
  message: 'Bulk message from Node.js!'
}, {
  headers: { 'X-API-Key': 'YOUR_API_KEY' }
});

console.log(\`Sent: \${response.data.sent}, Failed: \${response.data.failed}\`);</code></pre>
    </div>

    <h2><i class="fas fa-chart-bar"></i> Get Bot Status</h2>
    <div class="endpoint">
      <span class="method get">GET</span>
      <div class="url">/api/v1/status</div>
      <h3>Response</h3>
      <pre><code>{
  "success": true,
  "bot": {
    "connected": true,
    "uptime": 3600,
    "totalUsers": 150
  }
}</code></pre>
    </div>

    <h2><i class="fas fa-users"></i> Get Users List</h2>
    <div class="endpoint">
      <span class="method get">GET</span>
      <div class="url">/api/v1/users</div>
      <h3>Response</h3>
      <pre><code>{
  "success": true,
  "users": [
    {
      "phone": "254712345678",
      "name": "John Doe",
      "balance": 500.00,
      "messageCount": 25,
      "banned": false
    }
  ]
}</code></pre>
    </div>

    <h2><i class="fas fa-exclamation-triangle"></i> Error Responses</h2>
    <div class="endpoint">
      <pre><code>// 401 Unauthorized
{ "success": false, "error": "API key required" }

// 400 Bad Request
{ "success": false, "error": "Phone and message are required" }

// 503 Service Unavailable
{ "success": false, "error": "WhatsApp bot is not connected" }</code></pre>
    </div>
  </div>

  <script>
    function showLang(endpoint, lang) {
      document.querySelectorAll('#' + endpoint + '-php, #' + endpoint + '-python, #' + endpoint + '-node, #' + endpoint + '-curl')
        .forEach(el => el.classList.remove('active'));
      document.getElementById(endpoint + '-' + lang).classList.add('active');
      
      event.target.parentElement.querySelectorAll('.lang-tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log('🌐 Dashboard running at http://0.0.0.0:' + PORT);
  console.log('✅ Web server is ready and accepting connections');
  
  try {
    await initDatabase();
    await initializeDefaultSettings();
    await loadBotSettings();
    startKeepAlive();
    console.log('🚀 FY\'S PROPERTY Bot starting...');
    console.log('📊 Dashboard will be available at port', PORT);
  } catch (err) {
    console.error('❌ Initialization error:', err.message);
    botError = 'Initialization failed: ' + err.message;
  }
  
  console.log('🤖 Starting WhatsApp client...');
  
  setTimeout(() => {
    initializeWhatsApp();
  }, 2000);
});

function formatPhone(input) {
  if (!input) return null;
  let phone = input.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.length < 10 || phone.length > 15) return null;
  return phone + '@c.us';
}

async function safeSend(jid, text) {
  try {
    if (botReady && client) {
      await client.sendMessage(jid, text);
    }
  } catch (err) {
    console.error('❌ Send Error:', err.message);
  }
}

const userReplySent = new Set();
const REPLY_CACHE_TTL = 60000;

async function userReply(msg, text) {
  const msgId = msg.id._serialized || msg.id.id;
  const replyKey = `${msgId}_reply`;
  
  if (userReplySent.has(replyKey)) {
    console.log('⚠️ Duplicate reply prevented for:', msgId);
    return;
  }
  userReplySent.add(replyKey);
  setTimeout(() => userReplySent.delete(replyKey), REPLY_CACHE_TTL);
  
  try {
    await msg.reply(text + USER_SUFFIX);
  } catch (err) {
    console.error('❌ Reply Error:', err.message);
  }
}

async function adminReply(jid, text) {
  await safeSend(jid, text);
}

function showAdminMenu(jid) {
  adminReply(jid, getAdminMenu());
}

function setupMessageHandler(whatsappClient) {
  if (!whatsappClient) return;
  
  whatsappClient.on('message', async msg => {
  const msgId = msg.id._serialized || msg.id.id;
  if (processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  setTimeout(() => processedMessages.delete(msgId), MESSAGE_CACHE_TTL);
  
  const from = msg.from, txt = msg.body.trim(), lc = txt.toLowerCase();
  if (from.endsWith('@g.us')) return;
  
  if (msg.hasMedia && conversations[from]?.stage === 'addRec:file') {
    const user = users[from];
    if (user) {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const buffer = Buffer.from(media.data, 'base64');
          const filename = media.filename || 'contacts.txt';
          const phones = parseContactsFromFile(buffer, filename);
          if (phones.length === 0) {
            delete conversations[from];
            return userReply(msg, `⚠️ *No Valid Contacts Found*\n\nThe file doesn't contain valid phone numbers.\n\n💡 Type *3* to try again.`);
          }
          let added = 0, duplicates = 0;
          for (const phone of phones) {
            const formatted = formatPhone(phone);
            if (formatted && !user.recipients.includes(formatted)) {
              user.recipients.push(formatted);
              added++;
            } else if (formatted) duplicates++;
          }
          saveUsers(users);
          delete conversations[from];
          return userReply(msg, `✅ *CONTACTS IMPORTED!*\n\n📥 Found: ${phones.length}\n➕ Added: ${added}\n🔄 Duplicates: ${duplicates}\n👥 Total: ${user.recipients.length}\n\n🚀 Type *1* to broadcast!`);
        }
      } catch (err) {
        delete conversations[from];
        return userReply(msg, `⚠️ *Error Processing File*\n\nType *3* to try again.`);
      }
    }
  }

  if (adminUsers.has(from)) {
    if (txt === '00') { delete adminSessions[from]; return showAdminMenu(from); }
    if (txt === '0') { delete adminSessions[from]; return showAdminMenu(from); }
    
    const sess = adminSessions[from] || {};
    
    if (!sess.awaiting || sess.awaiting === 'main') {
      switch (txt) {
        case '1': {
          let out = '👥 *All Registered Users* 👥\n';
          const userList = Object.entries(users);
          if (userList.length === 0) {
            out += '\n_No users registered yet._';
          } else {
            for (let [jid, u] of userList) {
              out += `\n\n✨ *${u.name}*\n` +
                     `📱 ${u.phone}\n` +
                     `💰 Balance: Ksh ${u.balance.toFixed(2)}\n` +
                     `📊 Sent: ${u.messageCount} | Charges: Ksh ${u.totalCharges.toFixed(2)}\n` +
                     `${u.banned ? `🚫 BANNED: ${u.banReason}` : '✅ Active'}`;
            }
          }
          delete adminSessions[from];
          return adminReply(from, out);
        }
        case '2': sess.awaiting = 'chgCost'; adminSessions[from] = sess; return adminReply(from, '💱 Enter new costPerChar (e.g., 0.02):');
        case '3': sess.awaiting = 'modBal'; sess.step = 'getUser'; adminSessions[from] = sess; return adminReply(from, '💰 Enter user phone number:');
        case '4': sess.awaiting = 'banUser'; sess.step = 'getUser'; adminSessions[from] = sess; return adminReply(from, '🚫 Enter user phone to Ban/Unban:');
        case '5': sess.awaiting = 'bulkAll'; sess.step = 'getMsg'; adminSessions[from] = sess; return adminReply(from, '📢 Type your broadcast message:');
        case '6': sess.awaiting = 'addAdmin'; adminSessions[from] = sess; return adminReply(from, '➕ Enter new admin phone number:');
        case '7': sess.awaiting = 'rmvAdmin'; adminSessions[from] = sess; return adminReply(from, '❌ Enter admin phone to remove:');
        case '8': return adminReply(from, `🌐 *Dashboard URL:*\n${SELF_URL}\n\n_Access from any browser!_`);
        case '9': {
          const recentTxns = await getTransactions(10);
          let out = '💳 *Recent Transactions* 💳\n';
          if (recentTxns.length === 0) {
            out += '\n_No transactions yet._';
          } else {
            for (let t of recentTxns) {
              const statusEmoji = t.status === 'completed' ? '✅' : t.status === 'pending' ? '⏳' : '❌';
              out += `\n\n${statusEmoji} *${t.user_name || 'N/A'}*\n` +
                     `📱 ${t.phone}\n` +
                     `💰 Ksh ${parseFloat(t.amount || 0).toFixed(2)}\n` +
                     `🔖 ${t.reference || 'N/A'}`;
            }
          }
          delete adminSessions[from];
          return adminReply(from, out);
        }
        case '10': sess.awaiting = 'editBotName'; adminSessions[from] = sess; 
          return adminReply(from, `📝 *Edit Bot Name*\n\nCurrent: *${getBotName()}*\n\nEnter new bot name:`);
        case '11': sess.awaiting = 'editWelcome'; adminSessions[from] = sess; 
          return adminReply(from, `👋 *Edit Welcome Text*\n\nCurrent:\n${getWelcomeText()}\n\n📝 Send your new welcome message:`);
        case '12': sess.awaiting = 'editSupport'; adminSessions[from] = sess; 
          return adminReply(from, `🆘 *Edit Support Text*\n\nCurrent:\n${getSupportText()}\n\n📝 Send your new support message:`);
        case '13': sess.awaiting = 'editTopup'; adminSessions[from] = sess; 
          return adminReply(from, `💳 *Edit Topup Prompt*\n\nCurrent:\n${getTopupPrompt()}\n\n📝 Send your new topup prompt:`);
        case '14': sess.awaiting = 'editRegSuccess'; adminSessions[from] = sess; 
          return adminReply(from, `🎉 *Edit Registration Success*\n\nUse {name} for username placeholder.\n\nCurrent:\n${botSettings.regSuccessTemplate || DEFAULT_SETTINGS.regSuccessTemplate}\n\n📝 Send your new registration message:`);
        case '15': sess.awaiting = 'editLowBal'; adminSessions[from] = sess; 
          return adminReply(from, `⚠️ *Edit Low Balance Message*\n\nPlaceholders: {cost}, {balance}, {shortfall}\n\nCurrent:\n${botSettings.notEnoughBalTemplate || DEFAULT_SETTINGS.notEnoughBalTemplate}\n\n📝 Send your new message:`);
        case '16': {
          const settings = await getAllSettings();
          let out = '📋 *All Bot Settings* 📋\n\n';
          out += `🏷️ *Bot Name:* ${getBotName()}\n`;
          out += `👤 *Admin Label:* ${botSettings.fromAdmin || config.fromAdmin}\n`;
          out += `💱 *Cost/Char:* Ksh ${botSettings.costPerChar || config.costPerChar}\n`;
          out += `🔧 *Maintenance:* ${isMaintenanceMode() ? '🔴 ON' : '🟢 OFF'}\n`;
          out += `\n*Feature Status:*\n`;
          out += `🎁 Referrals: ${isFeatureEnabled('featureReferrals') ? '✅' : '❌'}\n`;
          out += `📋 Templates: ${isFeatureEnabled('featureTemplates') ? '✅' : '❌'}\n`;
          out += `📊 Analytics: ${isFeatureEnabled('featureAnalytics') ? '✅' : '❌'}\n`;
          out += `👑 VIP System: ${isFeatureEnabled('featureVIP') ? '✅' : '❌'}\n`;
          out += `\n📱 Type 10-20 to edit settings.`;
          return adminReply(from, out);
        }
        case '17': {
          const current = isMaintenanceMode();
          await setSetting('maintenanceMode', current ? 'false' : 'true');
          botSettings.maintenanceMode = current ? 'false' : 'true';
          delete adminSessions[from];
          if (!current) {
            return adminReply(from, `🔴 *MAINTENANCE MODE ENABLED*\n\nAll users will now see the maintenance message.\n\nType 18 to edit the message.`);
          } else {
            for (const jid of Object.keys(users)) {
              await safeSend(jid, `🎉 *We're Back Online!*\n\nMaintenance is complete. You can now use all features!\n\nType *menu* to continue.`);
            }
            return adminReply(from, `🟢 *MAINTENANCE MODE DISABLED*\n\nAll users have been notified!`);
          }
        }
        case '18': sess.awaiting = 'editMaintenance'; adminSessions[from] = sess; 
          return adminReply(from, `✏️ *Edit Maintenance Message*\n\nCurrent:\n${getMaintenanceMessage()}\n\n📝 Send your new maintenance message:`);
        case '19': {
          let out = `⚡ *Feature Toggles* ⚡\n\n`;
          out += `Current Status:\n`;
          out += `1️⃣ 🎁 Referrals: ${isFeatureEnabled('featureReferrals') ? '✅ ON' : '❌ OFF'}\n`;
          out += `2️⃣ 📋 Templates: ${isFeatureEnabled('featureTemplates') ? '✅ ON' : '❌ OFF'}\n`;
          out += `3️⃣ 📊 Analytics: ${isFeatureEnabled('featureAnalytics') ? '✅ ON' : '❌ OFF'}\n`;
          out += `4️⃣ 👑 VIP System: ${isFeatureEnabled('featureVIP') ? '✅ ON' : '❌ OFF'}\n`;
          out += `5️⃣ 📆 Scheduled Msgs: ${isFeatureEnabled('featureScheduledMsgs') ? '✅ ON' : '❌ OFF'}\n`;
          out += `\n_Reply with number to toggle (e.g., 1 to toggle Referrals)_`;
          sess.awaiting = 'toggleFeature'; adminSessions[from] = sess;
          return adminReply(from, out);
        }
        case '20': {
          let out = `👑 *VIP User Management* 👑\n\n`;
          const vipUsers = Object.entries(users).filter(([, u]) => u.vip);
          if (vipUsers.length === 0) {
            out += `_No VIP users yet._\n\n`;
          } else {
            out += `*Current VIP Users:*\n`;
            for (const [jid, u] of vipUsers) {
              out += `• ${u.name} (${u.phone})\n`;
            }
            out += `\n`;
          }
          out += `VIP Discount: ${botSettings.vipDiscount || 20}%\n\n`;
          out += `1️⃣ Add VIP User\n`;
          out += `2️⃣ Remove VIP User\n`;
          out += `3️⃣ Change VIP Discount`;
          sess.awaiting = 'vipMenu'; adminSessions[from] = sess;
          return adminReply(from, out);
        }
        case '21': {
          const currentBonus = botSettings.referralBonus || 50;
          sess.awaiting = 'setReferralBonus'; adminSessions[from] = sess;
          return adminReply(from, `🎁 *Set Referral Bonus*\n\n💰 Current Bonus: *Ksh ${currentBonus}*\n\nEnter new referral bonus amount (e.g., 100):`);
        }
        case '22': {
          const currentMin = botSettings.topupMinAmount || 10;
          sess.awaiting = 'setMinTopup'; adminSessions[from] = sess;
          return adminReply(from, `📉 *Set Minimum Top-up Amount*\n\n💰 Current Minimum: *Ksh ${currentMin}*\n\nEnter new minimum top-up amount:`);
        }
        case '23': {
          const currentMax = botSettings.topupMaxAmount || 150000;
          sess.awaiting = 'setMaxTopup'; adminSessions[from] = sess;
          return adminReply(from, `📈 *Set Maximum Top-up Amount*\n\n💎 Current Maximum: *Ksh ${currentMax}*\n\nEnter new maximum top-up amount:`);
        }
        default:
          return showAdminMenu(from);
      }
    }

    switch (sess.awaiting) {
      case 'chgCost': {
        const val = parseFloat(txt);
        if (isNaN(val) || val < 0) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid number.'); }
        await setSetting('costPerChar', String(val));
        botSettings.costPerChar = String(val);
        delete adminSessions[from];
        return adminReply(from, `✅ Cost per character updated to *Ksh ${val}*`);
      }
      case 'modBal': {
        if (sess.step === 'getUser') {
          const jid = formatPhone(txt);
          if (!jid || !users[jid]) { delete adminSessions[from]; return adminReply(from, '⚠️ User not found.'); }
          sess.target = jid;
          sess.step = 'getAmt';
          adminSessions[from] = sess;
          return adminReply(from, `💰 *${users[jid].name}*\nCurrent Balance: Ksh ${users[jid].balance.toFixed(2)}\n\nEnter amount to add (use - for subtract):`);
        }
        if (sess.step === 'getAmt') {
          const amt = parseFloat(txt);
          if (isNaN(amt)) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid amount.'); }
          users[sess.target].balance += amt;
          saveUsers(users);
          delete adminSessions[from];
          return adminReply(from, `✅ *${users[sess.target].name}* balance updated!\n\nNew Balance: Ksh ${users[sess.target].balance.toFixed(2)}`);
        }
        break;
      }
      case 'banUser': {
        if (sess.step === 'getUser') {
          const jid = formatPhone(txt);
          if (!jid || !users[jid]) { delete adminSessions[from]; return adminReply(from, '⚠️ User not found.'); }
          sess.target = jid;
          if (users[jid].banned) {
            users[jid].banned = false;
            users[jid].banReason = '';
            saveUsers(users);
            delete adminSessions[from];
            return adminReply(from, `✅ *${users[jid].name}* has been UNBANNED!`);
          }
          sess.step = 'getReason';
          adminSessions[from] = sess;
          return adminReply(from, `🚫 Banning *${users[jid].name}*\n\nEnter ban reason:`);
        }
        if (sess.step === 'getReason') {
          users[sess.target].banned = true;
          users[sess.target].banReason = txt;
          saveUsers(users);
          delete adminSessions[from];
          return adminReply(from, `🚫 *${users[sess.target].name}* has been BANNED!\n\nReason: _${txt}_`);
        }
        break;
      }
      case 'bulkAll': {
        if (sess.step === 'getMsg') {
          const userList = Object.keys(users);
          if (userList.length === 0) {
            delete adminSessions[from];
            return adminReply(from, '⚠️ No users to broadcast to.');
          }
          let sent = 0;
          const fromName = botSettings.fromAdmin || config.fromAdmin;
          for (let jid of userList) {
            await safeSend(jid, `📢 *${fromName}:*\n\n${txt}`);
            sent++;
          }
          delete adminSessions[from];
          return adminReply(from, `✅ *Broadcast Sent Successfully!*\n\n📤 Delivered to ${sent} users.`);
        }
        break;
      }
      case 'addAdmin': {
        const jid = formatPhone(txt);
        if (!jid) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid phone number.'); }
        adminUsers.add(jid);
        await addAdminToDb(jid);
        delete adminSessions[from];
        return adminReply(from, `✅ *New Admin Added!*\n\n📱 ${jid.replace('@c.us', '')}`);
      }
      case 'rmvAdmin': {
        const jid = formatPhone(txt);
        if (!jid || !adminUsers.has(jid) || jid === SUPER_ADMIN) {
          delete adminSessions[from];
          return adminReply(from, '⚠️ Cannot remove that admin.');
        }
        adminUsers.delete(jid);
        await removeAdminFromDb(jid);
        delete adminSessions[from];
        return adminReply(from, `❌ *Admin Removed:* ${jid.replace('@c.us', '')}`);
      }
      case 'editBotName': {
        await setSetting('botName', txt);
        botSettings.botName = txt;
        delete adminSessions[from];
        return adminReply(from, `✅ Bot name updated to: *${txt}*`);
      }
      case 'editWelcome': {
        await setSetting('welcomeText', txt);
        botSettings.welcomeText = txt;
        delete adminSessions[from];
        return adminReply(from, `✅ Welcome text updated successfully!`);
      }
      case 'editSupport': {
        await setSetting('supportText', txt);
        botSettings.supportText = txt;
        delete adminSessions[from];
        return adminReply(from, `✅ Support text updated successfully!`);
      }
      case 'editTopup': {
        await setSetting('topupPrompt', txt);
        botSettings.topupPrompt = txt;
        delete adminSessions[from];
        return adminReply(from, `✅ Topup prompt updated successfully!`);
      }
      case 'editRegSuccess': {
        await setSetting('regSuccessTemplate', txt);
        botSettings.regSuccessTemplate = txt;
        delete adminSessions[from];
        return adminReply(from, `✅ Registration success message updated!`);
      }
      case 'editLowBal': {
        await setSetting('notEnoughBalTemplate', txt);
        botSettings.notEnoughBalTemplate = txt;
        delete adminSessions[from];
        return adminReply(from, `✅ Low balance message updated!`);
      }
      case 'editMaintenance': {
        await setSetting('maintenanceMessage', txt);
        botSettings.maintenanceMessage = txt;
        delete adminSessions[from];
        return adminReply(from, `✅ Maintenance message updated!`);
      }
      case 'toggleFeature': {
        const featureMap = {
          '1': 'featureReferrals',
          '2': 'featureTemplates',
          '3': 'featureAnalytics',
          '4': 'featureVIP',
          '5': 'featureScheduledMsgs'
        };
        const feature = featureMap[txt];
        if (!feature) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid option.'); }
        const current = isFeatureEnabled(feature);
        await setSetting(feature, current ? 'false' : 'true');
        botSettings[feature] = current ? 'false' : 'true';
        delete adminSessions[from];
        return adminReply(from, `✅ *${feature.replace('feature', '')}* is now ${current ? '❌ OFF' : '✅ ON'}!`);
      }
      case 'vipMenu': {
        if (txt === '1') {
          sess.awaiting = 'addVIP'; adminSessions[from] = sess;
          return adminReply(from, '👑 Enter phone number to add as VIP:');
        } else if (txt === '2') {
          sess.awaiting = 'removeVIP'; adminSessions[from] = sess;
          return adminReply(from, '👑 Enter phone number to remove from VIP:');
        } else if (txt === '3') {
          sess.awaiting = 'vipDiscount'; adminSessions[from] = sess;
          return adminReply(from, `💎 Current VIP Discount: ${botSettings.vipDiscount || 20}%\n\nEnter new discount percentage:`);
        }
        delete adminSessions[from];
        return adminReply(from, '⚠️ Invalid option.');
      }
      case 'addVIP': {
        const jid = formatPhone(txt);
        if (!jid || !users[jid]) { delete adminSessions[from]; return adminReply(from, '⚠️ User not found.'); }
        users[jid].vip = true;
        saveUsers(users);
        delete adminSessions[from];
        return adminReply(from, `✅ *${users[jid].name}* is now a VIP member! 👑`);
      }
      case 'removeVIP': {
        const jid = formatPhone(txt);
        if (!jid || !users[jid]) { delete adminSessions[from]; return adminReply(from, '⚠️ User not found.'); }
        users[jid].vip = false;
        saveUsers(users);
        delete adminSessions[from];
        return adminReply(from, `✅ *${users[jid].name}* removed from VIP.`);
      }
      case 'vipDiscount': {
        const val = parseFloat(txt);
        if (isNaN(val) || val < 0 || val > 100) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid percentage (0-100).'); }
        await setSetting('vipDiscount', String(val));
        botSettings.vipDiscount = String(val);
        delete adminSessions[from];
        return adminReply(from, `✅ VIP Discount updated to *${val}%*!`);
      }
      case 'setReferralBonus': {
        const val = parseFloat(txt);
        if (isNaN(val) || val < 0) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid amount. Please enter a positive number.'); }
        await setSetting('referralBonus', String(val));
        botSettings.referralBonus = String(val);
        delete adminSessions[from];
        return adminReply(from, `✅ *Referral Bonus Updated!*\n\n🎁 New Bonus: *Ksh ${val}* per referral`);
      }
      case 'setMinTopup': {
        const val = parseFloat(txt);
        if (isNaN(val) || val < 1) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid amount. Minimum must be at least Ksh 1.'); }
        const currentMax = parseFloat(botSettings.topupMaxAmount) || 150000;
        if (val >= currentMax) { delete adminSessions[from]; return adminReply(from, `⚠️ Minimum must be less than maximum (Ksh ${currentMax}).`); }
        await setSetting('topupMinAmount', String(val));
        botSettings.topupMinAmount = String(val);
        delete adminSessions[from];
        return adminReply(from, `✅ *Minimum Top-up Updated!*\n\n📉 New Minimum: *Ksh ${val}*`);
      }
      case 'setMaxTopup': {
        const val = parseFloat(txt);
        if (isNaN(val) || val < 1) { delete adminSessions[from]; return adminReply(from, '⚠️ Invalid amount. Please enter a positive number.'); }
        const currentMin = parseFloat(botSettings.topupMinAmount) || 10;
        if (val <= currentMin) { delete adminSessions[from]; return adminReply(from, `⚠️ Maximum must be greater than minimum (Ksh ${currentMin}).`); }
        await setSetting('topupMaxAmount', String(val));
        botSettings.topupMaxAmount = String(val);
        delete adminSessions[from];
        return adminReply(from, `✅ *Maximum Top-up Updated!*\n\n📈 New Maximum: *Ksh ${val}*`);
      }
      default:
        delete adminSessions[from];
        return adminReply(from, '⚠️ Session expired. Returning to menu.');
    }
  }

  if (!users[from]) {
    if (!conversations[from]) {
      conversations[from] = { stage: 'awaitRegister' };
      return userReply(msg, getWelcomeText());
    }
    const conv = conversations[from];
    
    if (conv.stage === 'awaitRegister') {
      const uname = txt.trim();
      if (uname.length < 2) {
        return userReply(msg, '⚠️ Username too short! Please use at least 2 characters.');
      }
      if (/^[0-9]+$/.test(uname)) {
        return userReply(msg, '⚠️ Username cannot be only numbers. Please choose a name with letters.');
      }
      if (Object.values(users).some(u => u.name && u.name.toLowerCase() === uname.toLowerCase())) {
        return userReply(msg, '⚠️ That username is already taken! Please choose another one.');
      }
      conv.username = uname;
      conv.stage = 'awaitReferral';
      conversations[from] = conv;
      if (isFeatureEnabled('featureReferrals')) {
        return userReply(msg, `✨ *Great choice, ${uname}!* ✨\n\n🎁 *Do you have a referral code?*\n\nIf someone invited you, enter their referral code now to give them credit!\n\n1️⃣ *Enter Referral Code*\n2️⃣ *Skip - I don't have one*\n\n📱 _Reply with 1 or 2:_`);
      } else {
        conv.stage = 'completeReg';
        conversations[from] = conv;
      }
    }
    
    if (conv.stage === 'awaitReferral') {
      if (txt === '1') {
        conv.stage = 'enterReferralCode';
        conversations[from] = conv;
        return userReply(msg, `🔗 *Enter Referral Code*\n\nType the referral code you received:\n\n💡 _Example: REF123456_`);
      } else if (txt === '2' || lc === 'skip') {
        conv.stage = 'completeReg';
        conv.referralCode = null;
        conversations[from] = conv;
      } else {
        return userReply(msg, `⚠️ Please reply with *1* to enter a referral code or *2* to skip.`);
      }
    }
    
    if (conv.stage === 'enterReferralCode') {
      const refCode = txt.toUpperCase().trim();
      const referrer = Object.entries(users).find(([jid, u]) => 
        u.referralCode && u.referralCode.toUpperCase() === refCode
      );
      if (referrer) {
        conv.referralCode = refCode;
        conv.referrerJid = referrer[0];
        conv.stage = 'completeReg';
        conversations[from] = conv;
      } else {
        return userReply(msg, `⚠️ *Invalid Referral Code*\n\nThat code doesn't exist. Please check and try again.\n\nOr type *2* to skip and continue without a referral code.`);
      }
    }
    
    if (conv.stage === 'completeReg') {
      const uname = conv.username;
      users[from] = {
        name: uname,
        phone: from.replace('@c.us', ''),
        registeredAt: new Date().toISOString(),
        balance: 0, banned: false, banReason: '',
        messageCount: 0, totalCharges: 0,
        recipients: [],
        referredBy: conv.referrerJid || null,
        referralBonusPaid: false
      };
      saveUsers(users);
      
      if (conv.referrerJid && users[conv.referrerJid]) {
        const referrer = users[conv.referrerJid];
        referrer.referrals = referrer.referrals || [];
        if (!referrer.referrals.includes(from)) {
          referrer.referrals.push(from);
        }
        referrer.pendingReferrals = referrer.pendingReferrals || [];
        if (!referrer.pendingReferrals.includes(from)) {
          referrer.pendingReferrals.push(from);
        }
        saveUsers(users);
        
        const bonus = parseFloat(botSettings.referralBonus) || 50;
        await safeSend(conv.referrerJid,
          `🎁 *NEW REFERRAL REGISTERED!* 🎁\n\n` +
          `Someone just registered using your referral code!\n\n` +
          `👤 *New User:* ${uname}\n` +
          `💰 *Potential Bonus:* Ksh ${bonus}\n\n` +
          `📌 *Note:* Your bonus will be credited once they make their first deposit of at least Ksh 5!\n\n` +
          `📊 *Total Referrals:* ${referrer.referrals.length}\n\n` +
          `🚀 Keep sharing your code to earn more!`
        );
      }
      
      delete conversations[from];
      for (let adm of adminUsers) {
        await safeSend(adm,
          `🎉🆕 *New User Alert!* 🆕🎉\n\n` +
          `✨ *Username:* ${uname}\n` +
          `📱 *Phone:* ${users[from].phone}\n` +
          `🔗 *Referred by:* ${conv.referrerJid ? users[conv.referrerJid]?.name || 'Unknown' : 'None'}\n` +
          `🕐 *Registered:* ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' })}\n\n` +
          `👥 Total Users: ${Object.keys(users).length}`
        );
      }
      
      let successMsg = getRegSuccess(uname);
      if (conv.referrerJid) {
        successMsg = `🎁 *Referral Applied!* You were referred by *${users[conv.referrerJid]?.name || 'a friend'}*!\n\n💡 _Your referrer will earn their bonus once you make your first deposit of Ksh 5 or more!_\n\n` + successMsg;
      }
      return userReply(msg, successMsg);
    }
    return;
  }

  const user = users[from];
  if (user.banned) {
    return userReply(msg, `🚫 *Access Denied!* 🚫\n\nYour account has been suspended.\n\n📝 *Reason:* _${user.banReason}_\n\n💬 Contact support for assistance.`);
  }
  
  if (isMaintenanceMode()) {
    return msg.reply(getMaintenanceMessage());
  }
  
  if (lc === '00' || lc === 'menu' || lc === 'hi' || lc === 'hello' || lc === 'hey') {
    delete conversations[from];
    return userReply(msg, getUserMenu(user));
  }
  
  if (lc === '0') {
    if (conversations[from]) {
      delete conversations[from];
      return userReply(msg, `🔙 *Going back...*\n\n` + getUserMenu(user));
    }
    return userReply(msg, getUserMenu(user));
  }
  
  if (lc === '8' || lc === 'delete my account') {
    delete users[from];
    saveUsers(users);
    return userReply(msg, '❌ Your account has been deleted.\n\n_Send any message to register again._');
  }
  
  if (lc === '7') {
    return userReply(msg, getSupportText());
  }
  
  if (lc === '6') {
    return userReply(msg,
      `💰 *Your Account Summary* 💰\n\n` +
      `👤 *Name:* ${user.name}\n` +
      `💵 *Balance:* Ksh ${user.balance.toFixed(2)}\n` +
      `📤 *Messages Sent:* ${user.messageCount}\n` +
      `💸 *Total Charges:* Ksh ${user.totalCharges.toFixed(2)}\n` +
      `👥 *Recipients:* ${user.recipients.length}\n\n` +
      `📅 *Member since:* ${new Date(user.registeredAt).toLocaleDateString('en-GB')}`
    );
  }

  if (lc === '5' || conversations[from]?.stage?.startsWith('topup')) {
    const conv = conversations[from] || {};
    if (lc === '5') {
      conversations[from] = { stage: 'topup:amount' };
      return userReply(msg, getTopupPrompt());
    }
    if (conv.stage === 'topup:amount') {
      const amt = parseFloat(txt);
      const minAmount = parseFloat(botSettings.topupMinAmount) || 10;
      const maxAmount = parseFloat(botSettings.topupMaxAmount) || 150000;
      if (isNaN(amt) || amt < minAmount) {
        delete conversations[from];
        return userReply(msg, `⚠️ *Invalid Amount!*\n\nMinimum top-up is Ksh ${minAmount}.\n\nType *5* to try again.`);
      }
      if (amt > maxAmount) {
        delete conversations[from];
        return userReply(msg, `⚠️ *Amount Too High!*\n\nMaximum top-up is Ksh ${maxAmount}.\n\nType *5* to try again.`);
      }
      conv.amount = amt;
      conv.stage = 'topup:phone';
      conversations[from] = conv;
      return userReply(msg, `📱 *Phone Number Required*\n\nEnter the M-PESA number to charge *Ksh ${amt.toFixed(2)}*\n\n_Format: 0712345678 or 254712345678_`);
    }
    if (conv.stage === 'topup:phone') {
      const mp = formatPhone(txt), amt = conv.amount;
      delete conversations[from];
      if (!mp) return userReply(msg, '⚠️ *Invalid Phone Number!*\n\nType *5* to restart.');
      
      const phoneNum = mp.replace('@c.us', '');
      await msg.reply(`⏳ *Processing Your Top-up* ⏳\n\n💰 Amount: Ksh ${amt.toFixed(2)}\n📱 Phone: ${phoneNum}\n\n📲 _Check your phone for M-PESA prompt..._`);
      
      const result = await sendSTKPush(amt, phoneNum, user.name, from);
      
      if (!result || !result.success) {
        return userReply(msg, `❌ *STK Push Failed!*\n\n${result?.message || 'Please try again later.'}`);
      }
      
      await safeSend(from, `✅ *STK Push Sent Successfully!*\n\n📲 Enter your M-PESA PIN on your phone to complete.\n\n⏳ _Waiting for payment confirmation..._`);
      
      pollPaymentStatus(result.checkoutRequestId, from, user, amt);
      return;
    }
    return;
  }

  // Handle addRec: entry point (option 3) OR active conversation - prioritize before other menu options
  if (lc === '3' || conversations[from]?.stage?.startsWith('addRec')) {
    // Entry point: user pressed 3 to add recipients
    if (lc === '3' && !conversations[from]?.stage?.startsWith('addRec')) {
      conversations[from] = { stage: 'addRec:choice' };
      return userReply(msg, `
╔══════════════════════════════════════╗
║    ➕ *ADD RECIPIENTS* ➕            ║
╠══════════════════════════════════════╣
║                                      ║
║  Choose how to add contacts:         ║
║                                      ║
║  1️⃣  📝 *Manual Entry*              ║
║      Type numbers one by one         ║
║                                      ║
║  2️⃣  📁 *Upload File*               ║
║      Send CSV, VCF, TXT or JSON      ║
║                                      ║
╚══════════════════════════════════════╝

📱 _Reply with *1* or *2* to continue_
0️⃣ _Type *0* to go back_`);
    }
    
    // Handle active conversation stages
    if (conversations[from]?.stage?.startsWith('addRec')) {
    const conv = conversations[from];
    if (conv.stage === 'addRec:choice') {
      if (txt === '1') {
        conv.stage = 'addRec:manual';
        conversations[from] = conv;
        return userReply(msg, `
╔══════════════════════════════════════╗
║    📝 *MANUAL ENTRY MODE* 📝        ║
╠══════════════════════════════════════╣
║                                      ║
║  Enter the phone number:             ║
║                                      ║
║  ✅ *Accepted Formats:*              ║
║     • 0712345678                     ║
║     • 254712345678                   ║
║     • +254712345678                  ║
║                                      ║
╚══════════════════════════════════════╝

📱 _Type the number now..._`);
      } else if (txt === '2') {
        conv.stage = 'addRec:file';
        conversations[from] = conv;
        return userReply(msg, `
╔══════════════════════════════════════╗
║    📁 *FILE UPLOAD MODE* 📁         ║
╠══════════════════════════════════════╣
║                                      ║
║  📤 *Send your contact file now*    ║
║                                      ║
║  ✅ *Supported Formats:*             ║
║     • CSV (comma-separated)          ║
║     • VCF (vCard contacts)           ║
║     • TXT (one number per line)      ║
║     • JSON (array with phone)        ║
║                                      ║
║  💡 *Tips:*                          ║
║     • Max 5MB file size              ║
║     • Duplicates auto-removed        ║
║                                      ║
╚══════════════════════════════════════╝

📎 _Attach and send your file..._`);
      } else if (lc === '0' || lc === 'menu') {
        delete conversations[from];
        return userReply(msg, getUserMenu(user));
      } else {
        return userReply(msg, `⚠️ *Invalid Choice!*\n\nPlease reply with *1* for manual entry or *2* for file upload.\n\n💡 Type *0* to go back or *menu* for main options.`);
      }
    }
    if (conv.stage === 'addRec:manual') {
      if (lc === '0' || lc === 'menu') {
        delete conversations[from];
        return userReply(msg, getUserMenu(user));
      }
      const jid = formatPhone(txt);
      if (!jid) {
        return userReply(msg, `⚠️ *Invalid Phone Number!*\n\nPlease enter a valid number.\n\n📱 _Examples: 0712345678 or 254712345678_\n\n💡 Type *0* to go back or *menu* for main options.`);
      }
      if (user.recipients.includes(jid)) {
        return userReply(msg, `⚠️ *Already Exists!*\n\n📱 ${jid.replace('@c.us', '')} is already in your list.\n\n💡 Enter another number or type *0* to go back.`);
      }
      user.recipients.push(jid);
      saveUsers(users);
      return userReply(msg, `
╔══════════════════════════════════════╗
║    ✅ *RECIPIENT ADDED!* ✅          ║
╠══════════════════════════════════════╣
║                                      ║
║  📱 *Number:* ${jid.replace('@c.us', '').padEnd(18)}║
║  👥 *Total:* ${String(user.recipients.length).padEnd(19)}║
║                                      ║
╚══════════════════════════════════════╝

📝 _Enter another number to add more_
📋 _Type *menu* for main options_
0️⃣ _Type *0* to go back_`);
    }
    if (conv.stage === 'addRec:file') {
      if (lc === '0' || lc === 'menu') {
        delete conversations[from];
        return userReply(msg, getUserMenu(user));
      }
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            const buffer = Buffer.from(media.data, 'base64');
            const filename = media.filename || 'contacts.txt';
            const phones = parseContactsFromFile(buffer, filename);
            if (phones.length === 0) {
              return userReply(msg, `
╔══════════════════════════════════════╗
║    ⚠️ *NO CONTACTS FOUND* ⚠️         ║
╠══════════════════════════════════════╣
║                                      ║
║  The file doesn't contain valid      ║
║  phone numbers we could import.      ║
║                                      ║
║  💡 *Tips:*                          ║
║     • Check file format              ║
║     • Ensure numbers are valid       ║
║     • Use supported formats only     ║
║                                      ║
╚══════════════════════════════════════╝

📋 Type *3* to try again or *menu* for main options`);
            }
            let added = 0;
            let duplicates = 0;
            for (const phone of phones) {
              const formatted = formatPhone(phone);
              if (formatted && !user.recipients.includes(formatted)) {
                user.recipients.push(formatted);
                added++;
              } else if (formatted) {
                duplicates++;
              }
            }
            saveUsers(users);
            delete conversations[from];
            return userReply(msg, `
╔══════════════════════════════════════╗
║  ✅ *CONTACTS IMPORTED!* ✅          ║
╠══════════════════════════════════════╣
║                                      ║
║  📥 *Found:* ${String(phones.length).padEnd(20)}║
║  ➕ *Added:* ${String(added).padEnd(20)}║
║  🔄 *Duplicates:* ${String(duplicates).padEnd(15)}║
║                                      ║
║  👥 *Total Recipients:* ${String(user.recipients.length).padEnd(10)}║
║                                      ║
╚══════════════════════════════════════╝

🚀 Ready to broadcast! Type *1* to send.
📋 Type *menu* for all options.`);
          }
        } catch (err) {
          delete conversations[from];
          return userReply(msg, `⚠️ *Error Processing File!*\n\nCouldn't read the file. Please try again with a valid contact file.\n\n💡 Type *3* to try again.`);
        }
      }
      return userReply(msg, `📎 *Waiting for your file...*\n\nPlease send a CSV, VCF, TXT or JSON file.\n\n💡 Type *0* to go back or *menu* for main options.`);
    }
    }
  }

  if (lc === '1' || conversations[from]?.stage === 'awaitBulk') {
    if (lc === '1') {
      if (user.recipients.length === 0) {
        return userReply(msg, `⚠️ *No Recipients Found!*\n\nYou need to add recipients first.\n\n💡 Use Option 3 to add recipients.`);
      }
      conversations[from] = { stage: 'awaitBulk' };
      return userReply(msg, `📢 *Broadcast Mode* 📢\n\n👥 Recipients: ${user.recipients.length}\n\n📝 Type your message now:`);
    }
    if (conversations[from].stage === 'awaitBulk') {
      const m = txt;
      delete conversations[from];
      const costPerChar = parseFloat(botSettings.costPerChar) || config.costPerChar;
      const cost = m.length * costPerChar;
      if (user.balance < cost) {
        return userReply(msg, getNotEnoughBal(cost, user.balance));
      }
      let sent = 0;
      const fromName = botSettings.fromAdmin || config.fromAdmin;
      for (let r of user.recipients) {
        await safeSend(r, `📢 *${fromName}:*\n\n${m}`);
        sent++;
      }
      user.balance -= cost;
      user.messageCount++;
      user.totalCharges += cost;
      saveUsers(users);
      return userReply(msg, `✅ *Broadcast Sent Successfully!* ✅\n\n📤 Delivered to: ${sent} recipients\n💸 Cost: Ksh ${cost.toFixed(2)}\n💰 New Balance: Ksh ${user.balance.toFixed(2)}`);
    }
    return;
  }

  if (lc === '2') {
    const list = user.recipients.length
      ? user.recipients.map((r, i) => `${i + 1}. 📱 ${r.replace('@c.us', '')}`).join('\n')
      : '_No recipients yet._\n\n💡 Use Option 3 to add some!';
    return userReply(msg, `📋 *Your Recipients List* 📋\n\n${list}\n\n👥 Total: ${user.recipients.length}`);
  }

  if (lc === '4' || conversations[from]?.stage === 'remRec') {
    if (lc === '4') {
      if (user.recipients.length === 0) {
        return userReply(msg, '⚠️ You have no recipients to remove.');
      }
      conversations[from] = { stage: 'remRec' };
      const list = user.recipients.map((r, i) => `${i + 1}. 📱 ${r.replace('@c.us', '')}`).join('\n');
      return userReply(msg, `❌ *Remove Recipient* ❌\n\n${list}\n\nEnter the number (1-${user.recipients.length}) to remove:`);
    }
    const idx = parseInt(txt) - 1;
    delete conversations[from];
    if (isNaN(idx) || idx < 0 || idx >= user.recipients.length) {
      return userReply(msg, '⚠️ Invalid selection. Type *4* to try again.');
    }
    const removed = user.recipients.splice(idx, 1)[0];
    saveUsers(users);
    return userReply(msg, `✅ *Recipient Removed!*\n\n📱 ${removed.replace('@c.us', '')}\n\n👥 Remaining: ${user.recipients.length}`);
  }

  if ((lc === '9' || conversations[from]?.stage?.startsWith('template')) && isFeatureEnabled('featureTemplates')) {
    user.templates = user.templates || [];
    if (lc === '9') {
      let out = `📋 *Message Templates* 📋\n\n`;
      if (user.templates.length === 0) {
        out += `_No templates saved yet._\n\n`;
      } else {
        out += `*Your Templates:*\n`;
        user.templates.forEach((t, i) => { out += `${i + 1}. ${t.substring(0, 30)}${t.length > 30 ? '...' : ''}\n`; });
        out += `\n`;
      }
      out += `1️⃣ Add New Template\n2️⃣ Use Template\n3️⃣ Delete Template`;
      conversations[from] = { stage: 'template:menu' };
      return userReply(msg, out);
    }
    const conv = conversations[from];
    if (conv.stage === 'template:menu') {
      if (txt === '1') { conv.stage = 'template:add'; conversations[from] = conv; return userReply(msg, '📝 Enter your template message:'); }
      if (txt === '2') { 
        if (user.templates.length === 0) { delete conversations[from]; return userReply(msg, '⚠️ No templates to use.'); }
        conv.stage = 'template:use'; conversations[from] = conv; 
        return userReply(msg, `Select template (1-${user.templates.length}):`); 
      }
      if (txt === '3') { 
        if (user.templates.length === 0) { delete conversations[from]; return userReply(msg, '⚠️ No templates to delete.'); }
        conv.stage = 'template:del'; conversations[from] = conv; 
        return userReply(msg, `Delete which template (1-${user.templates.length})?`); 
      }
      delete conversations[from]; return userReply(msg, '⚠️ Invalid option.');
    }
    if (conv.stage === 'template:add') { user.templates.push(txt); saveUsers(users); delete conversations[from]; return userReply(msg, `✅ Template saved! You now have ${user.templates.length} templates.`); }
    if (conv.stage === 'template:use') { const i = parseInt(txt) - 1; delete conversations[from]; if (i >= 0 && i < user.templates.length) { conversations[from] = { stage: 'awaitBulk' }; return userReply(msg, `📢 *Using Template:*\n\n${user.templates[i]}\n\n_This will be sent to ${user.recipients.length} recipients. Type YES to confirm or any other message to edit._`); } return userReply(msg, '⚠️ Invalid selection.'); }
    if (conv.stage === 'template:del') { const i = parseInt(txt) - 1; delete conversations[from]; if (i >= 0 && i < user.templates.length) { user.templates.splice(i, 1); saveUsers(users); return userReply(msg, `✅ Template deleted!`); } return userReply(msg, '⚠️ Invalid selection.'); }
    delete conversations[from]; return;
  }

  if ((lc === '10' || conversations[from]?.stage?.startsWith('referral')) && isFeatureEnabled('featureReferrals')) {
    user.referralCode = user.referralCode || ('REF' + user.phone.slice(-6));
    user.referrals = user.referrals || [];
    user.pendingReferrals = user.pendingReferrals || [];
    saveUsers(users);
    if (lc === '10') {
      const bonus = parseFloat(botSettings.referralBonus) || 50;
      const completedReferrals = user.referrals.length - user.pendingReferrals.length;
      const totalEarned = completedReferrals * bonus;
      const pendingEarnings = user.pendingReferrals.length * bonus;
      
      return userReply(msg, `🎁 *Referral Program* 🎁\n\n🔗 *Your Referral Code:*\n\`${user.referralCode}\`\n\n💰 *Earn:* Ksh ${bonus} per referral!\n\n📊 *Statistics:*\n✅ *Completed Referrals:* ${completedReferrals}\n⏳ *Pending Referrals:* ${user.pendingReferrals.length}\n\n💵 *Total Earned:* Ksh ${totalEarned}\n💫 *Pending Earnings:* Ksh ${pendingEarnings}\n\n📌 *How it works:*\n1. Share your referral code with friends\n2. They enter it during registration\n3. You earn Ksh ${bonus} when they deposit Ksh 5+\n\n🚀 _Start sharing and earning today!_`);
    }
    delete conversations[from]; return;
  }

  if (lc === '11' && isFeatureEnabled('featureAnalytics')) {
    const daysSinceReg = Math.floor((Date.now() - new Date(user.registeredAt).getTime()) / (1000 * 60 * 60 * 24));
    const avgMsgPerDay = daysSinceReg > 0 ? (user.messageCount / daysSinceReg).toFixed(2) : user.messageCount;
    return userReply(msg, `📊 *Your Analytics* 📊\n\n╔═══════════════════════╗\n║ 📈 *Activity Stats*\n╠═══════════════════════╣\n║ 📤 Messages Sent: ${user.messageCount}\n║ 👥 Recipients: ${user.recipients.length}\n║ 💸 Total Spent: Ksh ${user.totalCharges.toFixed(2)}\n║ 📅 Days Active: ${daysSinceReg}\n║ 📊 Avg/Day: ${avgMsgPerDay} msgs\n╠═══════════════════════╣\n║ 💰 *Financial*\n╠═══════════════════════╣\n║ 💵 Current Balance: Ksh ${user.balance.toFixed(2)}\n║ 📉 Cost/Char: Ksh ${botSettings.costPerChar || config.costPerChar}\n${user.vip ? '║ 👑 VIP Discount: ' + (botSettings.vipDiscount || 20) + '%\n' : ''}╚═══════════════════════╝`);
  }

  return userReply(msg, getUserMenu(user));
  });
}

async function sendSTKPush(amount, phone, userName, userId) {
  if (!config.apiKey || !config.apiSecret) {
    return { success: false, message: 'Payment gateway not configured. Please contact admin.' };
  }
  
  const reference = 'FYS' + Date.now().toString(36).toUpperCase();
  const callbackUrl = SELF_URL + '/api/payment/callback';
  
  const payload = {
    payment_account_id: parseInt(config.paymentAccountId) || 17,
    phone: phone,
    amount: amount,
    reference: reference,
    description: `Top-up for ${userName}`,
    callback_url: callbackUrl
  };
  
  const maxRetries = 3;
  let lastError = null;
  
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      console.log(`📤 Sending STK Push (attempt ${retry + 1}):`, { phone, amount, reference });
      
      const res = await axios.post(
        'https://shadow-pay.top/api/v2/stkpush.php',
        payload,
        {
          headers: {
            'X-API-Key': config.apiKey,
            'X-API-Secret': config.apiSecret,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      
      console.log('📥 STK Response:', res.data);
      
      if (res.data.success) {
        await saveTransaction({
          reference: reference,
          checkoutRequestId: res.data.checkout_request_id,
          merchantRequestId: res.data.merchant_request_id,
          userId: userId,
          userName: userName,
          phone: phone,
          amount: amount,
          status: 'pending',
          transactionCode: null
        });
        
        return {
          success: true,
          checkoutRequestId: res.data.checkout_request_id,
          reference: reference
        };
      } else {
        console.error('❌ STK Push Error:', res.data.message);
        return { success: false, message: res.data.message || 'Payment request failed' };
      }
    } catch (err) {
      lastError = err;
      console.error(`❌ STK Push Error (attempt ${retry + 1}):`, err.response?.data || err.message);
      
      if (retry < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  
  return { success: false, message: lastError?.response?.data?.message || lastError?.message || 'Network error. Please try again.' };
}

async function checkPaymentStatus(checkoutRequestId) {
  try {
    const res = await axios.post(
      'https://shadow-pay.top/api/v2/status.php',
      { checkout_request_id: checkoutRequestId },
      {
        headers: {
          'X-API-Key': config.apiKey,
          'X-API-Secret': config.apiSecret,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    console.log('📊 Payment Status:', res.data);
    return res.data;
  } catch (err) {
    console.error("❌ Status Check Error:", err.response?.data || err.message);
    return { success: false, message: err.message };
  }
}

async function pollPaymentStatus(checkoutRequestId, userId, user, amount) {
  const maxAttempts = 40;
  let attempt = 0;
  const pollInterval = 3000;
  
  pendingPayments.set(checkoutRequestId, { userId, user, amount });
  
  const poll = async () => {
    attempt++;
    
    if (!pendingPayments.has(checkoutRequestId)) {
      console.log('✅ Payment already processed via callback:', checkoutRequestId);
      return;
    }
    
    try {
      const status = await checkPaymentStatus(checkoutRequestId);
      
      if (status.success) {
        const paymentStatus = status.status;
        
        if (paymentStatus === 'completed') {
          pendingPayments.delete(checkoutRequestId);
          
          user.balance += amount;
          saveUsers(users);
          
          await updateTransactionStatus(checkoutRequestId, 'completed', status.transaction_code);
          
          const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' });
          
          await safeSend(userId,
            `🎉✨ *TOP-UP SUCCESSFUL!* ✨🎉\n\n` +
            `💰 *Amount:* Ksh ${amount.toFixed(2)}\n` +
            `📱 *M-PESA Code:* ${status.transaction_code || 'N/A'}\n` +
            `💵 *New Balance:* Ksh ${user.balance.toFixed(2)}\n\n` +
            `🙏 Thank you for your payment!\n` +
            `🚀 _Your balance has been updated instantly!_`
          );
          
          await safeSend(SUPER_ADMIN,
            `💰💰 *DEPOSIT ALERT!* 💰💰\n\n` +
            `👤 *User:* ${user.name}\n` +
            `📱 *Phone:* ${user.phone}\n` +
            `💵 *Amount:* Ksh ${amount.toFixed(2)}\n` +
            `🔖 *Code:* ${status.transaction_code || 'N/A'}\n` +
            `🕐 *Time:* ${now}`
          );
          
          if (amount >= 5 && user.referredBy && !user.referralBonusPaid) {
            const referrer = users[user.referredBy];
            if (referrer) {
              const bonus = parseFloat(botSettings.referralBonus) || 50;
              referrer.balance += bonus;
              user.referralBonusPaid = true;
              
              if (referrer.pendingReferrals) {
                referrer.pendingReferrals = referrer.pendingReferrals.filter(r => r !== userId);
              }
              
              saveUsers(users);
              
              await safeSend(user.referredBy,
                `🎉🎁💰 *REFERRAL BONUS EARNED!* 💰🎁🎉\n\n` +
                `Your referral *${user.name}* just made their first deposit!\n\n` +
                `💵 *Bonus Credited:* Ksh ${bonus}\n` +
                `💰 *Your New Balance:* Ksh ${referrer.balance.toFixed(2)}\n\n` +
                `🎊 Congratulations! Keep referring to earn more!\n` +
                `📊 *Completed Referrals:* ${(referrer.referrals?.length || 0) - (referrer.pendingReferrals?.length || 0)}\n` +
                `⏳ *Pending Referrals:* ${referrer.pendingReferrals?.length || 0}\n\n` +
                `🚀 _Share your referral code and earn Ksh ${bonus} per successful referral!_`
              );
              
              await safeSend(SUPER_ADMIN,
                `🎁 *REFERRAL BONUS PAID!* 🎁\n\n` +
                `👤 *Referrer:* ${referrer.name}\n` +
                `🆕 *New User:* ${user.name}\n` +
                `💵 *Deposit:* Ksh ${amount.toFixed(2)}\n` +
                `🎁 *Bonus Paid:* Ksh ${bonus}\n` +
                `🕐 *Time:* ${now}`
              );
            }
          }
          
          return;
        } else if (paymentStatus === 'failed' || paymentStatus === 'cancelled') {
          pendingPayments.delete(checkoutRequestId);
          await updateTransactionStatus(checkoutRequestId, 'failed');
          
          await safeSend(userId,
            `❌ *Payment Failed* ❌\n\n` +
            `Your M-PESA payment was not completed.\n\n` +
            `💡 *Possible reasons:*\n` +
            `• Wrong PIN entered\n` +
            `• Insufficient funds\n` +
            `• Request cancelled\n\n` +
            `Type *5* to try again.`
          );
          return;
        }
      }
      
      if (attempt < maxAttempts) {
        if (attempt === 10) {
          await safeSend(userId, '⏳ *Still waiting...* Please enter your M-PESA PIN.');
        } else if (attempt === 25) {
          await safeSend(userId, '⏳ *Almost there...* Complete the payment on your phone.');
        }
        setTimeout(poll, pollInterval);
      } else {
        pendingPayments.delete(checkoutRequestId);
        await updateTransactionStatus(checkoutRequestId, 'failed');
        
        await safeSend(userId,
          `⏰ *Payment Timeout* ⏰\n\n` +
          `We didn't receive your payment confirmation.\n\n` +
          `If money was deducted, it will be reversed automatically.\n\n` +
          `Type *5* to try again.`
        );
      }
    } catch (err) {
      console.error('❌ Poll Error:', err.message);
      if (attempt < maxAttempts) {
        setTimeout(poll, pollInterval);
      } else {
        pendingPayments.delete(checkoutRequestId);
      }
    }
  };
  
  setTimeout(poll, 3000);
}

function startKeepAlive() {
  const url = SELF_URL + '/keep-alive';
  const httpInterval = 2 * 60 * 1000;
  const whatsappInterval = 3 * 60 * 1000;
  
  setInterval(async () => {
    try {
      await axios.get(url, { timeout: 10000 });
    } catch (err) {
    }
  }, httpInterval);
  
  setInterval(async () => {
    try {
      if (client && botReady) {
        const state = await client.getState();
        if (state === 'CONNECTED') {
          console.log('💚 WhatsApp connection healthy');
        } else {
          console.log('⚠️ WhatsApp state:', state, '- attempting to maintain connection');
        }
      }
    } catch (err) {
      console.log('⚠️ WhatsApp health check error:', err.message);
    }
  }, whatsappInterval);
  
  console.log('🔄 Keep-alive mechanism started (HTTP: 2min, WhatsApp: 3min)');
}

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
  botError = `System error: ${err.message}`;
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  botError = `Async error: ${reason}`;
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  try {
    if (pool) await pool.end();
    if (client) await client.destroy();
  } catch (err) {
    console.error('Error during shutdown:', err.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down...');
  try {
    if (pool) await pool.end();
    if (client) await client.destroy();
  } catch (err) {
    console.error('Error during shutdown:', err.message);
  }
  process.exit(0);
});
