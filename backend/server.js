require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright-core"); 

const app = express(); 
const PORT = process.env.PORT || 3001;
const BB_KEY = process.env.BROWSERBASE_API_KEY || "bb_live_ObfYaIPxJbYfxQ_e1IMbsmwuluE";
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

async function createBrowser() {
  const response = await fetch("https://www.browserbase.com/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bb-api-key": BB_KEY,
    },
    body: JSON.stringify({ projectId: BB_PROJECT }),
  });
  const bbSession = await response.json();
  console.log("Browserbase session created:", bbSession.id);
  if (!bbSession.id) throw new Error("Failed to create Browserbase session: " + JSON.stringify(bbSession));
  const connectUrl = bbSession.connectUrl || `wss://connect.browserbase.com?apiKey=${BB_KEY}&sessionId=${bbSession.id}`;
  const browser = await chromium.connectOverCDP(connectUrl);
  return { browser };
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
    const page = await context.newPage();

    // Step 1: Go to FDA homepage and click Log-In
    await page.goto("https://www.access.fda.gov", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button'));
      const btn = btns.find(b => b.textContent.toLowerCase().includes('log'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    // Step 2: Check "I understand" and click Login
    await page.check('input[type="checkbox"]').catch(() => {});
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button'));
      const btn = btns.find(b => b.textContent.toLowerCase().includes('login') || b.textContent.toLowerCase().includes('log in'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

        // Step 3: Enter Account ID
    await page.waitForTimeout(2000);
    const step3Inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input'))
        .map(i => `${i.type}|${i.id}|${i.name}`);
    });
    console.log("Step 3 inputs:", JSON.stringify(step3Inputs));
    
    await safeFill(page, 'input[name="accountId"], input[name="username"], input[type="text"]', fdaUsername);
    await page.waitForTimeout(500);
    
    const step3Clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      console.log('Step 3 buttons:', btns.map(b => b.textContent || b.value).join(', '));
      const btn = btns.find(b => (b.textContent || b.value || '').trim().toLowerCase() === 'next');
      if (btn) { btn.click(); return 'Clicked Next'; }
      const anyBtn = btns[0];
      if (anyBtn) { anyBtn.click(); return 'Clicked: ' + (anyBtn.textContent || anyBtn.value); }
      return 'No button found';
    });
    console.log("Step 3 button result:", step3Clicked);
    
    const step3Page = await page.evaluate(() => document.body.innerText);
    console.log("Page after Account ID:", step3Page.substring(0, 200));
    await page.waitForTimeout(3000);


           // Step 4: Enter Password - use real keyboard simulation
    await page.waitForTimeout(3000);
    
    // First click on the password field to focus it
    const focused = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const pwd = inputs.find(i => i.type === 'password');
      if (pwd) { pwd.focus(); pwd.click(); return 'Focused password field'; }
      return 'No password field';
    });
    console.log("Focus result:", focused);
    await page.waitForTimeout(500);
    
    // Clear field and type character by character
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(fdaPassword, { delay: 150 });
    console.log("Typed password via keyboard");
    await page.waitForTimeout(500);
    
    // Click Next button
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const btn = btns.find(b => (b.textContent || b.value || '').trim().toLowerCase() === 'next');
      if (btn) { btn.click(); return 'Clicked Next'; }
      return 'Next not found';
    });
    console.log("Next button result:", clicked);
    console.log("Waiting for Send Code popup...");
    await page.waitForTimeout(5000);



    
    // Step 5: Wait for Send Code popup to appear
    await page.waitForTimeout(5000);
    const pageAfterPwd = await page.evaluate(() => document.body.innerText);
    console.log("Page text after password Next:", pageAfterPwd.substring(0, 300));
    
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'));
      const el = all.find(e => (e.textContent || e.value || '').toLowerCase().includes('send code'));
      if (el) { el.click(); console.log('Clicked Send Code'); }
      else console.log('Send Code button NOT found - visible text logged above');
    }).catch(() => {});
    await page.waitForTimeout(8000);



    // Verify OTP was sent by checking page content
    const pageText = await page.textContent("body");
    console.log("Page after Send Code:", pageText.substring(0, 200));

    sessions[sessionId] = { browser, page, status: "awaiting_otp" };
    res.json({ success: true, status: "awaiting_otp" });


  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/submit-otp", async (req, res) => {
  const { sessionId, otp } = req.body;
  if (!sessionId || !otp)
    return res.status(400).json({ error: "sessionId and otp required" });

  const session = sessions[sessionId];
  if (!session)
    return res.status(404).json({ error: "Session not found or expired" });

  try {
    // Fill OTP
    await safeFill(session.page, 'input[placeholder="Enter Code Here"], input[name="otp"], input[name="code"], input[type="text"]', otp);
    await session.page.waitForTimeout(500);

    // Click Submit Code
    await session.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
      const btn = btns.find(b => b.textContent.toLowerCase().includes('submit code') || b.textContent.toLowerCase().includes('submit'));
      if (btn) btn.click();
    });
    await session.page.waitForTimeout(3000);

    // Click "Continue with Password" to skip passkey
    await session.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const btn = links.find(b => b.textContent.toLowerCase().includes('continue with password'));
      if (btn) btn.click();
    }).catch(() => {});
    await session.page.waitForTimeout(2000);

    session.status = "logged_in";
    res.json({ success: true, status: "logged_in" });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/submit-pnc", async (req, res) => {
  const { sessionId, invoice } = req.body;
  if (!sessionId || !invoice) return res.status(400).json({ error: "sessionId and invoice required" });
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found or expired" });
  if (session.status !== "logged_in") return res.status(400).json({ error: "Not logged in yet" });

  const { page, browser } = session;
  const logs = [];
  const log = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };

  try {
    // Step A: Click "Prior Notice System Interface" link
    log("Navigating to PNSI...");
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(l => l.textContent.includes('Prior Notice System Interface'));
      if (link) link.click();
    });
    await page.waitForTimeout(5000);
    log("Page after PNSI click: " + (await page.evaluate(() => document.title)));

    // Step B: Click "CREATE NEW PRIOR NOTICE"
    log("Clicking Create New Prior Notice...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.includes('CREATE NEW PRIOR NOTICE') || b.textContent.includes('Create New Prior Notice'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // Step C: Click "Transportation and Exportation Express Courier" in popup
    log("Selecting shipment type...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.includes('Transportation and Exportation Express Courier'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // Step D: Shipment Details - "No" already selected, click SAVE & CONTINUE
    log("Shipment Details - Save & Continue...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.includes('SAVE & CONTINUE') || b.textContent.includes('Save & Continue'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // Step E: Carrier page
    log("Filling Carrier details...");
    // Click Air button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.trim() === 'Air');
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);

    // Mode of Transportation - select Express Courier - Air
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes('Express Courier - Air'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });
    await page.waitForTimeout(500);

    // IATA Code - FX
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const iata = inputs.find(i => i.placeholder?.includes('IATA') || i.value === 'FX' || 
                   i.closest('td')?.previousElementSibling?.textContent?.includes('IATA'));
      if (iata) { iata.value = 'FX'; iata.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await page.waitForTimeout(500);

    // Tracking Number
    const trackingNumber = invoice.trackingNumber || invoice.invoiceNumber || '';
    await page.evaluate((tn) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const field = inputs.find(i => i.placeholder?.toLowerCase().includes('tracking') || 
                                     i.placeholder?.toLowerCase().includes('airway'));
      if (field) { field.value = tn; field.dispatchEvent(new Event('input', { bubbles: true })); }
    }, trackingNumber);
    await page.waitForTimeout(500);

    // State - Tennessee
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes('Tennessee'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });
    await page.waitForTimeout(1000);

    // Port of Arrival - Memphis
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes('Memphis'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });
    await page.waitForTimeout(500);

    // Arrival Date - today + 2 days
    const arrivalDate = new Date();
    arrivalDate.setDate(arrivalDate.getDate() + 2);
    const mm = String(arrivalDate.getMonth() + 1).padStart(2, '0');
    const dd = String(arrivalDate.getDate()).padStart(2, '0');
    const yyyy = arrivalDate.getFullYear();
    const dateStr = `${mm}/${dd}/${yyyy}`;
    await page.evaluate((ds) => {
      const inputs = Array.from(document.querySelectorAll('input[type="date"], input[type="text"]'));
      const dateField = inputs.find(i => i.placeholder?.includes('date') || i.type === 'date');
      if (dateField) { dateField.value = ds; dateField.dispatchEvent(new Event('change', { bubbles: true })); }
    }, dateStr);
    await page.waitForTimeout(500);

    // Save & Continue
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.includes('SAVE & CONTINUE') || b.textContent.includes('Save & Continue'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // Step F: Submitter Details - Click "Creating for Myself"
    log("Submitter Details - Creating for Myself...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.includes('Creating for Myself'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.includes('SAVE & CONTINUE') || b.textContent.includes('Save & Continue'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // Check we reached Create New Food Article page
    const pageTitle = await page.evaluate(() => document.querySelector('h1')?.textContent || document.title);
    log("Reached page: " + pageTitle);

    res.json({ success: true, logs, status: "reached_food_article" });

  } catch (err) {
    log("❌ " + err.message);
    res.status(500).json({ success: false, error: err.message, logs });
  }
});

    await page.waitForTimeout(5000);

    const body = await page.textContent("body");
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
    const log = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };
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

      const body = await page.textContent("body");
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
