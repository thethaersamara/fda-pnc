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
  try { await page.fill(selector, String(value)); } catch {}
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
  const connectUrl = bbSession.connectUrl || "wss://connect.browserbase.com?apiKey=" + BB_KEY + "&sessionId=" + bbSession.id;
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

    await page.goto("https://www.access.fda.gov",
 { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("a, button"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("log"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    await page.check("input[type='checkbox']").catch(() => {});
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("a, button"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("login") || b.textContent.toLowerCase().includes("log in"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    await page.waitForTimeout(2000);
    const step3Inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input")).map(i => i.type + "|" + i.id + "|" + i.name);
    });
    console.log("Step 3 inputs:", JSON.stringify(step3Inputs));

    await safeFill(page, "input[name='accountId'], input[name='username'], input[type='text']", fdaUsername);
    await page.waitForTimeout(500);

    const step3Clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const btn = btns.find(b => (b.textContent || b.value || "").trim().toLowerCase() === "next");
      if (btn) { btn.click(); return "Clicked Next"; }
      const anyBtn = btns[0];
      if (anyBtn) { anyBtn.click(); return "Clicked: " + (anyBtn.textContent || anyBtn.value); }
      return "No button found";
    });
    console.log("Step 3 button result:", step3Clicked);

    const step3Page = await page.evaluate(() => document.body.innerText);
    console.log("Page after Account ID:", step3Page.substring(0, 200));
    await page.waitForTimeout(3000);

    await page.waitForTimeout(3000);
    const focused = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const pwd = inputs.find(i => i.type === "password");
      if (pwd) { pwd.focus(); pwd.click(); return "Focused password field"; }
      return "No password field";
    });
    console.log("Focus result:", focused);
    await page.waitForTimeout(500);

    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(fdaPassword, { delay: 150 });
    console.log("Typed password via keyboard");
    await page.waitForTimeout(500);

    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const btn = btns.find(b => (b.textContent || b.value || "").trim().toLowerCase() === "next");
      if (btn) { btn.click(); return "Clicked Next"; }
      return "Next not found";
    });
    console.log("Next button result:", clicked);
    console.log("Waiting for Send Code popup...");
    await page.waitForTimeout(5000);

    await page.waitForTimeout(5000);
    const pageAfterPwd = await page.evaluate(() => document.body.innerText);
    console.log("Page text after password Next:", pageAfterPwd.substring(0, 300));

    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a"));
      const el = all.find(e => (e.textContent || e.value || "").toLowerCase().includes("send code"));
      if (el) { el.click(); }
    }).catch(() => {});
    await page.waitForTimeout(8000);

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
    await safeFill(session.page, "input[placeholder='Enter Code Here'], input[name='otp'], input[name='code'], input[type='text']", otp);
    await session.page.waitForTimeout(500);

    await session.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a, input[type='submit']"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("submit code") || b.textContent.toLowerCase().includes("submit"));
      if (btn) btn.click();
    });
    await session.page.waitForTimeout(3000);

    await session.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button"));
      const btn = links.find(b => b.textContent.toLowerCase().includes("continue with password"));
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
  const log = (msg) => { console.log("[PNC] " + msg); logs.push(msg); };

  try {
    log("Navigating to PNSI...");
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const link = links.find(l => l.textContent.includes("Prior Notice System Interface"));
      if (link) link.click();
    });
    await page.waitForTimeout(5000);
    log("Page after PNSI click: " + (await page.evaluate(() => document.title)));

    log("Clicking Create New Prior Notice...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("CREATE NEW PRIOR NOTICE") || b.textContent.includes("Create New Prior Notice"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    log("Selecting shipment type...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("Transportation and Exportation Express Courier"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    log("Shipment Details - Save and Continue...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("SAVE & CONTINUE") || b.textContent.includes("Save & Continue"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    log("Filling Carrier details...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.trim() === "Air");
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes("Express Courier - Air"));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const iata = inputs.find(i => (i.placeholder && i.placeholder.includes("IATA")) || i.value === "FX");
      if (iata) { iata.value = "FX"; iata.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await page.waitForTimeout(500);

    const trackingNumber = invoice.trackingNumber || invoice.invoiceNumber || "";
    await page.evaluate((tn) => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const field = inputs.find(i => (i.placeholder && (i.placeholder.toLowerCase().includes("tracking") || i.placeholder.toLowerCase().includes("airway"))));
      if (field) { field.value = tn; field.dispatchEvent(new Event("input", { bubbles: true })); }
    }, trackingNumber);
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes("Tennessee"));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes("Memphis"));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    await page.waitForTimeout(500);

    const arrivalDate = new Date();
    arrivalDate.setDate(arrivalDate.getDate() + 2);
    const mm = String(arrivalDate.getMonth() + 1).padStart(2, "0");
    const dd = String(arrivalDate.getDate()).padStart(2, "0");
    const yyyy = arrivalDate.getFullYear();
    const dateStr = mm + "/" + dd + "/" + yyyy;
    await page.evaluate((ds) => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const dateField = inputs.find(i => i.type === "date" || (i.placeholder && i.placeholder.toLowerCase().includes("date")));
      if (dateField) { dateField.value = ds; dateField.dispatchEvent(new Event("change", { bubbles: true })); }
    }, dateStr);
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("SAVE & CONTINUE") || b.textContent.includes);
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    log("Submitter Details - Creating for Myself...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("Creating for Myself"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);

       await page.waitForTimeout(2000);
    const addressPopup = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const okBtn = btns.find(b => b.textContent.trim() === "Ok" || b.textContent.trim() === "OK");
      if (okBtn) { okBtn.click(); return "Dismissed address popup"; }
      return "No popup found";
    });
    log("Address popup: " + addressPopup);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
      page.waitForTimeout(2000).then(() => page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"));
        const btn = btns.find(b => b.textContent.includes("SAVE & CONTINUE") || b.textContent.includes("Save & Continue"));
        if (btn) btn.click();
      }).catch(() => {}))
    ]);
    await page.waitForTimeout(4000);


    
    const pageTitle = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? h1.textContent : document.title;
    });

    log("Reached page: " + pageTitle);

    res.json({ success: true, logs, status: "reached_food_article" });

  } catch (err) {
    log("ERROR: " + err.message);
    res.status(500).json({ success: false, error: err.message, logs });
  }
});
app.post("/submit-all-pnc", async (req, res) => {
  const { sessionId, invoices } = req.body;
  if (!sessionId || !invoices || !invoices.length)
    return res.status(400).json({ error: "sessionId and invoices[] required" });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found or expired" });
  if (session.status !== "logged_in") return res.status(400).json({ error: "Not logged in yet" });

  const results = [];
  for (const invoice of invoices.filter((i) => i.needsPNC)) {
    const logs = [];
    const log = (msg) => { console.log("[PNC] " + msg); logs.push(msg); };
    const { page } = session;
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("a, button"));
        const btn = btns.find(b => b.textContent.toLowerCase().includes("create") || b.textContent.toLowerCase().includes("new prior"));
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);

      const item = invoice.items && invoice.items[0] ? invoice.items[0] : {};
      await safeFill(page, "#articleDescription, input[name='articleDescription']", item.description || "");
      await safeFill(page, "#quantity, input[name='quantity']", String(item.quantity || 1));
      await safeFill(page, "#harmonizedCode, input[name='hsCode']", item.hsCode || "");
      await safeFill(page, "#shipperName, input[name='shipperName']", invoice.shipper ? invoice.shipper.name : "");
      await safeFill(page, "#consigneeName, input[name='consigneeName']", invoice.consignee ? invoice.consignee.name : "");
      await safeFill(page, "#carrier, input[name='carrier']", "FedEx");
      await safeFill(page, "#billOfLading, input[name='trackingNumber']", invoice.trackingNumber || "");

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
        const btn = btns.find(b => b.textContent.toLowerCase().includes("submit"));
        if (btn) btn.click();
      });
      await page.waitForTimeout(5000);

      const body = await page.textContent("body");
      const match = body.match(/Prior Notice (?:Number|#|Confirmation)[:\s]+([A-Z0-9\-]+)/i);
      const confirmationNumber = match ? match[1] : "Submitted";
      log("PNC# " + confirmationNumber);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: true, confirmationNumber, logs });
    } catch (err) {
      log("ERROR: " + err.message);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: false, error: err.message, logs });
    }
  }

  delete sessions[sessionId];
  await session.browser.close();
  res.json({ results });
});

app.listen(PORT, () => console.log("Server running on port " + PORT));

