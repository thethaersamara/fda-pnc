require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const { chromium } = require("playwright-core"); 

const app      = express(); 
const PORT     = process.env.PORT || 3001;
const BB_KEY   = process.env.BROWSERBASE_API_KEY || "bb_live_ObfYaIPxJbYfxQ_e1IMbsmwuluE";
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID || "529bb6fc-5478-4648-b83c-e9eb4531a1fb";


app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());

const sessions = {};

async function safeFill(page, selector, value) {
  if (!value) return;
  try { await page.fill(selector, String(value)); } catch { }
}

async function safeSelect(page, selector, value) {
  if (!value) return;
  try {
    await page.selectOption(selector, { value }).catch(() =>
      page.selectOption(selector, { label: String(value) })
    );
  } catch { }
}

async function createBrowser() {
  const response = await fetch("https://www.browserbase.com/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bb-api-key": BB_KEY,
    },
    body: JSON.stringify({ projectId: BB_PROJECT }),
  });
  const session = await response.json();
  const browser = await chromium.connectOverCDP(
    `wss://connect.browserbase.com?apiKey=${BB_KEY}&sessionId=${session.id}`
  );
  return { browser, sessionId: session.id };
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/start-login", async (req, res) => {
  const { sessionId, fdaUsername, fdaPassword } = req.body;
  if (!sessionId || !fdaUsername || !fdaPassword)
    return res.status(400).json({ error: "sessionId, fdaUsername, fdaPassword required" });

  try {
        const { browser } = await createBrowser();
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    const page    = await context.newPage();


    await page.goto("https://www.access.fda.gov", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button'));
      const loginBtn = btns.find(b => b.textContent.toLowerCase().includes('log'));
      if (loginBtn) loginBtn.click();
    });
    await page.waitForTimeout(5000);

    await page.check('input[type="checkbox"]').catch(() => {});
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button'));
      const loginBtn = btns.find(b => b.textContent.toLowerCase().includes('login') || b.textContent.toLowerCase().includes('log in'));
      if (loginBtn) loginBtn.click();
    });
    await page.waitForTimeout(5000);

    await safeFill(page, 'input[name="accountId"], input[name="username"], input[type="text"]', fdaUsername);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"], input[type="submit"], button');
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    await safeFill(page, 'input[name="password"], input[type="password"]', fdaPassword);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"], input[type="submit"], button');
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

        // Click "Send Code" button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
      const sendBtn = btns.find(b => b.textContent.toLowerCase().includes('send code'));
      if (sendBtn) sendBtn.click();
    }).catch(() => {});
    await page.waitForTimeout(3000);


   app.post("/submit-otp", async (req, res) => {
  const { sessionId, otp } = req.body;
  if (!sessionId || !otp)
    return res.status(400).json({ error: "sessionId and otp required" });

  const session = sessions[sessionId];
  if (!session)
    return res.status(404).json({ error: "Session not found or expired" });

  try {
    // Fill OTP field
    await safeFill(session.page, 'input[placeholder="Enter Code Here"], input[name="otp"], input[name="code"], input[name="verificationCode"], input[type="text"]', otp);
    await session.page.waitForTimeout(500);

    // Click "Submit Code"
    await session.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
      const submitBtn = btns.find(b => b.textContent.toLowerCase().includes('submit code') || b.textContent.toLowerCase().includes('submit'));
      if (submitBtn) submitBtn.click();
    });
    await session.page.waitForTimeout(3000);

    // Click "Continue with Password" to skip passkey popup
    await session.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const continueBtn = links.find(b => b.textContent.toLowerCase().includes('continue with password'));
      if (continueBtn) continueBtn.click();
    }).catch(() => {});
    await session.page.waitForTimeout(2000);

    session.status = "logged_in";
    res.json({ success: true, status: "logged_in" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

    await session.page.waitForTimeout(5000);
    session.status = "logged_in";
    res.json({ success: true, status: "logged_in" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/submit-pnc", async (req, res) => {
  const { sessionId, invoice } = req.body;
  if (!sessionId || !invoice)
    return res.status(400).json({ error: "sessionId and invoice required" });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found or expired" });
  if (session.status !== "logged_in") return res.status(400).json({ error: "Not logged in yet" });

  const { page, browser } = session;
  const logs = [];
  const log  = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };

  try {
    log("Opening new Prior Notice...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button'));
      const btn = btns.find(b => b.textContent.toLowerCase().includes('create') || b.textContent.toLowerCase().includes('new prior'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    log("Filling form...");
    const item = invoice.items?.[0] || {};
    await safeFill(page, '#articleDescription, input[name="articleDescription"]', item.description || "");
    await safeFill(page, '#quantity, input[name="quantity"]', String(item.quantity || 1));
    await safeFill(page, '#harmonizedCode, input[name="hsCode"]', item.hsCode || "");
    await safeFill(page, '#shipperName, input[name="shipperName"]', invoice.shipper?.name || "");
    await safeFill(page, '#shipperAddress, input[name="shipperAddress"]', invoice.shipper?.address || "");
    await safeFill(page, '#consigneeName, input[name="consigneeName"]', invoice.consignee?.name || "");
    await safeFill(page, '#consigneeAddress, input[name="consigneeAddress"]', invoice.consignee?.address || "");
    await safeFill(page, '#carrier, input[name="carrier"]', "FedEx");
    await safeFill(page, '#billOfLading, input[name="trackingNumber"]', invoice.trackingNumber || invoice.invoiceNumber || "");

    log("Submitting...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const btn = btns.find(b => b.textContent.toLowerCase().includes('submit'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    const body  = await page.textContent("body");
    const match = body.match(/Prior Notice (?:Number|#|Confirmation)[:\s]+([A-Z0-9\-]+)/i);
    const confirmationNumber = match?.[1] || "Submitted — check PNC portal";
    log(`✅ PNC# ${confirmationNumber}`);

    delete sessions[sessionId];
    await browser.close();
    res.json({ success: true, confirmationNumber, logs });

  } catch (err) {
    log(`❌ ${err.message}`);
    res.status(500).json({ success: false, error: err.message, logs });
  }
});

app.post("/submit-all-pnc", async (req, res) => {
  const { sessionId, invoices } = req.body;
  if (!sessionId || !invoices?.length)
    return res.status(400).json({ error: "sessionId and invoices[] required" });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found or expired" });
  if (session.status !== "logged_in") return res.status(400).json({ error: "Not logged in yet" });

  const results = [];
  for (const invoice of invoices.filter((i) => i.needsPNC)) {
    const logs = [];
    const log  = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };
    const { page } = session;
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('a, button'));
        const btn = btns.find(b => b.textContent.toLowerCase().includes('create') || b.textContent.toLowerCase().includes('new prior'));
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);

      const item = invoice.items?.[0] || {};
      await safeFill(page, '#articleDescription, input[name="articleDescription"]', item.description || "");
      await safeFill(page, '#quantity, input[name="quantity"]', String(item.quantity || 1));
      await safeFill(page, '#harmonizedCode, input[name="hsCode"]', item.hsCode || "");
      await safeFill(page, '#shipperName, input[name="shipperName"]', invoice.shipper?.name || "");
      await safeFill(page, '#consigneeName, input[name="consigneeName"]', invoice.consignee?.name || "");
      await safeFill(page, '#carrier, input[name="carrier"]', "FedEx");
      await safeFill(page, '#billOfLading, input[name="trackingNumber"]', invoice.trackingNumber || "");

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const btn = btns.find(b => b.textContent.toLowerCase().includes('submit'));
        if (btn) btn.click();
      });
      await page.waitForTimeout(5000);

      const body  = await page.textContent("body");
      const match = body.match(/Prior Notice (?:Number|#|Confirmation)[:\s]+([A-Z0-9\-]+)/i);
      const confirmationNumber = match?.[1] || "Submitted";
      log(`✅ PNC# ${confirmationNumber}`);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: true, confirmationNumber, logs });
    } catch (err) {
      log(`❌ ${err.message}`);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: false, error: err.message, logs });
    }
  }

  delete sessions[sessionId];
  await session.browser.close();
  res.json({ results });
});

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
