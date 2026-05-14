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
    headers: { "Content-Type": "application/json", "x-bb-api-key": BB_KEY },
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

    await page.goto("https://www.access.fda.gov", { waitUntil: "domcontentloaded", timeout: 60000 });
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
    await safeFill(page, "input[name='accountId'], input[name='username'], input[type='text']", fdaUsername);
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const btn = btns.find(b => (b.textContent || b.value || "").trim().toLowerCase() === "next");
      if (btn) { btn.click(); return; }
      const anyBtn = btns[0];
      if (anyBtn) anyBtn.click();
    });
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
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const btn = btns.find(b => (b.textContent || b.value || "").trim().toLowerCase() === "next");
      if (btn) btn.click();
    });
    await page.waitForTimeout(10000);

    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a"));
      const el = all.find(e => (e.textContent || e.value || "").toLowerCase().includes("send code"));
      if (el) el.click();
    }).catch(() => {});
    await page.waitForTimeout(8000);

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
    await session.page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const otpInput = inputs.find(i => i.placeholder === "Enter Code Here");
      if (otpInput) { otpInput.focus(); otpInput.click(); }
    });
    await session.page.keyboard.press("Control+A");
    await session.page.keyboard.press("Backspace");
    await session.page.keyboard.type(otp, { delay: 150 });
    await session.page.waitForTimeout(1000);

    await session.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find(b => b.textContent.trim() === "Submit Code");
      if (btn) btn.click();
    });
    await session.page.waitForTimeout(3000);

    await session.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button"));
      const btn = links.find(b => b.textContent.toLowerCase().includes("continue with password"));
      if (btn) btn.click();
    }).catch(() => {});

    await session.page.waitForFunction(() =>
      document.body.innerText.includes("Prior Notice System Interface"),
      { timeout: 30000 }
    ).catch(() => {});
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

  const { page } = session;
  const logs = [];
  const log = (msg) => { console.log("[PNC] " + msg); logs.push(msg); };

  try {
    log("Navigating to PNSI...");
    await page.waitForTimeout(5000);

    const clicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const link = links.find(l =>
        l.textContent.trim() === "Prior Notice System Interface" && !l.closest("footer")
      );
      if (link) { link.click(); return "Clicked PNSI link"; }
      return "PNSI link not found";
    });
    log("PNSI click: " + clicked);
    await page.waitForTimeout(8000);

    // Handle "PNSI open in another browser" popup
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const yes = btns.find(b => b.textContent.trim() === "Yes");
      if (yes) yes.click();
    }).catch(() => {});
    await page.waitForTimeout(3000);

    const pnsiPage = await page.evaluate(() => document.body.innerText);
    if (!pnsiPage.includes("Prior Notice") && !pnsiPage.includes("PRIOR NOTICE")) {
      return res.status(401).json({ success: false, error: "Could not reach PNSI - please login again", logs });
    }

    log("Clicking Create New Prior Notice...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("CREATE NEW PRIOR NOTICE") || b.textContent.includes("Create New Prior Notice"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

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
    await page.waitForTimeout(2000);

    // Click Air button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.trim() === "Air");
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);

    // Select Mode of Transportation
    await page.locator("select[name='modeOfTransportation']").selectOption({ label: "Express Courier - Air" }).catch(async () => {
      await page.evaluate(() => {
        const sel = document.querySelector("select[name='modeOfTransportation']");
        if (sel) {
          const opt = Array.from(sel.options).find(o => o.text.includes("Express Courier - Air"));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
        }
      });
    });
    await page.waitForTimeout(1000);

    // Type IATA code FX
    await page.click("#iata-code", { clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("FX", { delay: 150 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(2000);
    log("IATA FX entered");

    // Type tracking number
    const trackingNumber = invoice.trackingNumber || invoice.invoiceNumber || "";
    await page.click("#trackingNumber", { clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(trackingNumber, { delay: 150 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);
    log("Tracking number entered: " + trackingNumber);

    // Select Tennessee
    try {
      await page.locator("select[name='state']").selectOption({ label: "Tennessee" });
    } catch(e) {}
    await page.waitForTimeout(3000);

    // Select Memphis
    await page.waitForFunction(() => {
      const sel = document.querySelector("select[name='portOfArrival']");
      return sel && Array.from(sel.options).some(o => o.text.includes("Memphis"));
    }, { timeout: 10000 }).catch(() => {});
    try {
      await page.locator("select[name='portOfArrival']").selectOption({ label: "Memphis, TN" });
    } catch(e) {
      await page.evaluate(() => {
        const sel = document.querySelector("select[name='portOfArrival']");
        if (sel) {
          const opt = Array.from(sel.options).find(o => o.text.includes("Memphis"));
          if (opt) {
            sel.value = opt.value;
            ["input", "change", "blur"].forEach(ev =>
              sel.dispatchEvent(new Event(ev, { bubbles: true }))
            );
          }
        }
      });
    }
    await page.waitForTimeout(500);

    // Enter arrival date
    const arrivalDate = new Date();
    arrivalDate.setDate(arrivalDate.getDate() + 2);
    const mm = String(arrivalDate.getMonth() + 1).padStart(2, "0");
    const dd = String(arrivalDate.getDate()).padStart(2, "0");
    const yyyy = arrivalDate.getFullYear();
    const dateStr = mm + "/" + dd + "/" + yyyy;
    await page.click("#portOfArrivalDate", { clickCount: 3 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.click("#portOfArrivalDate", { clickCount: 3 }).catch(() => {});
    await page.keyboard.type(dateStr, { delay: 100 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    log("Date entered: " + dateStr);

    // Set hour and minute
    await page.locator("select[name='hour']").selectOption("08").catch(() => {});
    await page.waitForTimeout(300);
    await page.locator("select[name='minute']").selectOption("00").catch(() => {});
    await page.waitForTimeout(300);
    log("Carrier details filled");

    // Save carrier page
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("SAVE & CONTINUE") || b.textContent.includes("Save & Continue"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    log("Submitter Details - Creating for Myself...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.trim() === "Creating for Myself");
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    log("Clicking SAVE & CONTINUE on submitter page...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const allBtns = btns.filter(b => b.textContent.includes("SAVE & CONTINUE") || b.textContent.includes("Save & Continue"));
      if (allBtns.length > 0) allBtns[allBtns.length - 1].click();
    });
    await page.waitForTimeout(5000);

    // Handle address popup
    const addressResult = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll("input[type='radio']"));
      const originalRadio = radios.find(r => {
        const parent = r.closest("label") || r.parentElement;
        return (parent && parent.textContent.includes("Original Address")) || r.value === "0";
      });
      if (originalRadio) originalRadio.click();
      const btns = Array.from(document.querySelectorAll("button"));
      const okBtn = btns.find(b => b.textContent.trim() === "Ok" || b.textContent.trim() === "OK");
      if (okBtn) { okBtn.click(); return "Clicked Original Address + Ok"; }
      return "No popup found";
    });
    log("Address result: " + addressResult);
    await page.waitForTimeout(4000);

    const pageTitle = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? h1.textContent : document.title;
    });
    log("Reached page: " + pageTitle);

    log("Adding food article...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("ADD FOOD ARTICLE"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    log("Copying from previous food article...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("Copy from a Previous Food Article"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);

    log("Selecting food article checkbox...");
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      rows.forEach(row => {
        const cb = row.querySelector("input[type='checkbox']");
        if (cb && cb.checked) cb.click();
      });
      const targetRow = rows.find(row => row.textContent.includes("Grape Molasses"));
      if (targetRow) {
        const cb = targetRow.querySelector("input[type='checkbox']");
        if (cb) cb.click();
      } else {
        const first = document.querySelector("tr input[type='checkbox']");
        if (first) first.click();
      }
    });
    await page.waitForTimeout(1000);

    log("Clicking Copy Food Articles button...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("COPY FOOD ARTICLE") || b.textContent.includes("Copy Food Article"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    log("Confirming...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find(b => b.textContent.trim() === "CONFIRM" || b.textContent.trim() === "Confirm");
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);

    log("Clicking pencil to edit article...");
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const tableRows = Array.from(document.querySelectorAll("tr"));
      for (const row of tableRows) {
        if (row.textContent.includes("In Progress")) {
          const btns = Array.from(row.querySelectorAll("button, a"));
          if (btns.length > 0) { btns[0].click(); return; }
        }
      }
    });
    await page.waitForTimeout(5000);

    log("Clicking Review...");
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      const reviewEl = all.find(el =>
        el.children.length === 0 &&
        el.textContent.trim() === "Review" &&
        el.tagName !== "SCRIPT" &&
        el.tagName !== "STYLE"
      );
      if (reviewEl) {
        reviewEl.click();
        const parent = reviewEl.closest("a, button, li");
        if (parent) parent.click();
      }
    });
    await page.waitForTimeout(5000);

    log("Adding article to submission...");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("add this article to my prior"));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    });

    // Wait for confirmation popup
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.some(b => b.textContent.includes("No, Done creating Food Articles"));
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    log("Handling Add Article Confirmation popup...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("no, done creating"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    // Wait for food article to be added
    await page.waitForFunction(() =>
      document.body.innerText.includes("Food Article Added") ||
      document.body.innerText.includes("Added to Prior Notice"),
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    log("Submitting to FDA...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("submit to fda"));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    });

    // Wait for submission to complete
    await page.waitForFunction(() =>
      document.body.innerText.includes("Submitted to FDA"),
      { timeout: 60000 }
    ).catch(() => {});
    log("Waited for Submitted to FDA status");
    await page.waitForTimeout(2000);

    log("Generating PDF...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("GENERATE PDF") || b.textContent.includes("Generate PDF"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);
    log("PDF generated");

    const finalPage = await page.evaluate(() => document.body.innerText);
    const confirmMatch = finalPage.match(/\d{12}/);
    const confirmationNumber = confirmMatch ? confirmMatch[0] : "Submitted - check PNSI";
    log("Confirmation: " + confirmationNumber);

    res.json({ success: true, logs, confirmationNumber, status: "submitted" });

  } catch (err) {
    log("ERROR: " + err.message);
    res.status(500).json({ success: false, error: err.message, logs });
  }
});

app.post("/parse-invoice", async (req, res) => {
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return res.status(400).json({ error: "pdfBase64 required" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64
              }
            },
            {
              type: "text",
              text: `Extract the following from this FedEx commercial invoice and return ONLY a JSON object with no extra text:
{
  "trackingNumber": "airway bill or tracking number, empty string if not found",
  "shipDate": "ship date in MM/DD/YYYY format",
  "shipper": {
    "name": "shipper full name",
    "address": "full address",
    "country": "country"
  },
  "consignee": {
    "name": "consignee full name", 
    "address": "full address",
    "country": "country"
  },
  "items": [
    {
      "description": "clean product name without FS/Personal use only prefix",
      "quantity": number,
      "unit": "PCS or KG etc",
      "weightKg": number,
      "countryOfOrigin": "2-letter country code",
      "value": number
    }
  ],
  "currency": "USD",
  "totalValue": number
}`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, invoice: parsed });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
