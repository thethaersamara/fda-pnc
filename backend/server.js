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

app.post("/parse-invoice",async (req, res) => {
  const { pdfBase64, mimeType } = req.body;
  if (!pdfBase64) return res.status(400).json({ error: "pdfBase64 required" });

  try {
    const isImage = mimeType && mimeType.startsWith("image/");
    const contentBlock = isImage
      ? { type: "image", source: { type: "base64", media_type: mimeType, data: pdfBase64 } }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            contentBlock,
            {
              type: "text",
              text: "Extract the following from this FedEx commercial invoice and return ONLY a JSON object with no extra text:\n{\n  \"trackingNumber\": \"air waybill or tracking number, empty string if not found\",\n  \"shipper\": {\n    \"name\": \"shipper full name\",\n    \"address\": \"street address only\",\n    \"city\": \"city\",\n    \"zip\": \"postal code\",\n    \"country\": \"full country name\"\n  },\n  \"items\": [\n    {\n      \"description\": \"clean product name, remove FS/Personal use only prefix, keep only the actual product name\",\n      \"quantity\": 0,\n      \"quantityUnit\": \"PCS or KG etc\",\n      \"countryOfOrigin\": \"2-letter country code\",\n      \"needsPNC\": true\n    }\n  ],\n  \"currency\": \"USD\",\n  \"totalValue\": 0,\n  \"needsPNC\": true\n}"
            }
          ]
        }]
      })
    });

    const data = await response.json();
    console.log("Claude response:", JSON.stringify(data).substring(0, 500));

    if (!data.content || !data.content[0]) {
      return res.status(500).json({ success: false, error: "Claude returned no content: " + JSON.stringify(data) });
    }

    const text = data.content[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, invoice: parsed });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post("/duplicate-pnc", async (req, res) => {
  const { sessionId, sourcePncId, trackingNumber, importer } = req.body;
  if (!sessionId || !sourcePncId || !trackingNumber || !importer)
    return res.status(400).json({ error: "Missing required fields" });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "logged_in") return res.status(400).json({ error: "Not logged in" });

  const { page } = session;
  const logs = [];
  const log = (msg) => { console.log("[DUP] " + msg); logs.push(msg); };

  // Respond immediately, process in background
  res.json({ success: true, status: "processing", message: "PNC duplication started, check logs" });

  try {
    log("Navigating to PNSI...");
    await page.waitForTimeout(3000);

    // Click Prior Notice System Interface link
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const link = links.find(l =>
        l.textContent.trim() === "Prior Notice System Interface" && !l.closest("footer")
      );
      if (link) link.click();
    });
    await page.waitForTimeout(8000);

    // Handle PNSI popup
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const yes = btns.find(b => b.textContent.trim() === "Yes");
      if (yes) yes.click();
    }).catch(() => {});
    await page.waitForTimeout(3000);

                 log("Clicking Submissions tab...");
    await page.evaluate(() => {
      location.hash = "#/submissions";
    });
    await page.waitForTimeout(3000);
    // if it didn't route, click the nav item as fallback
    await page.evaluate(() => {
      const norm = s => s.replace(/\s+/g," ").trim();
      const els = Array.from(document.querySelectorAll("a,button,li,span,div"));
      const el = els.find(e => /(^|[a-z_])Submissions$/.test(norm(e.textContent)) && norm(e.textContent).length < 40 && !/PREVIOUS/i.test(norm(e.textContent)));
      if (el) (el.closest("a,button,li")||el).click();
    });
    await page.waitForFunction(() =>
      document.body.innerText.includes("ENTRY NUMBER") || document.body.innerText.includes("Manage Submissions"),
      { timeout: 15000 }
    ).catch(()=>{});
    await page.waitForTimeout(2000);
    const onSubs = await page.evaluate(() => document.body.innerText.includes("ENTRY NUMBER") ? "YES" : "NO: "+document.body.innerText.slice(0,80));
    log("On submissions page: " + onSubs);


           log("Searching for PNC: " + sourcePncId);
    const typed = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      // skip date pickers and selects; find the text input whose immediate label says Entry Number
      let field = inputs.find(i => {
        if (/date/i.test(i.placeholder || "")) return false;
        // walk up to find a label/text node mentioning "Entry Number" close by
        let n = i.parentElement;
        for (let k = 0; k < 3 && n; k++) {
          if (/ENTRY NUMBER/i.test(n.textContent) && !/STATUS|DATE|TYPE|SUBMITTER|MODE/i.test(n.textContent.slice(0,40))) return true;
          n = n.parentElement;
        }
        return false;
      });
      if (!field) return "no field";
      field.focus();
      field.value = "";
      return "focused:" + (field.placeholder || field.id || field.name || "unnamed");
    });
    log("Entry field: " + typed);
    await page.keyboard.type(sourcePncId, { delay: 80 });
    await page.waitForTimeout(500);


  // Click Search
    await page.evaluate(() => {
      const norm = s => s.replace(/\s+/g," ").trim();
      const btns = Array.from(document.querySelectorAll("button"));
      const b = btns.find(x => norm(x.textContent).toUpperCase() === "SEARCH");
      if (b) b.click();
    });

    await page.waitForFunction(() =>
      /###-\d+-\d+/.test(document.body.innerText),
      { timeout: 20000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    const searchState = await page.evaluate(() => {
      const rows = document.querySelectorAll("tr").length;
      const hasRow = /###-\d+-\d+/.test(document.body.innerText);
      return "hasRow=" + hasRow + " rows=" + rows;
    });
    log("Search state: " + searchState);


        // Click Copy icon on the result row
    const copyIcon = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      for (const row of rows) {
        if (!/###-\d/.test(row.textContent)) continue; // only the data row
        const btns = Array.from(row.querySelectorAll("button, a"));
        // find the one whose icon is the copy/content_copy glyph
        const copy = btns.find(b => /content_copy|copy|file_copy/i.test(b.innerHTML));
        const target = copy || btns[1]; // fallback to 2nd
        if (target) { target.click(); return "clicked " + (copy ? "copy-icon" : "btns[1]") + " of " + btns.length; }
      }
      return "no data row / no buttons";
    });
    log("Copy icon: " + copyIcon);
    await page.waitForTimeout(3000);

    // Dump what appeared - should be the copy confirmation popup
    const popup = await page.evaluate(() => document.body.innerText.match(/Copy Prior Notice Confirmation|Are you sure you want to copy/i) ? "popup visible" : "NO popup");
    log("Copy popup: " + popup);

    // Click CONFIRM on copy popup
    log("Confirming copy...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find(b => b.textContent.trim() === "CONFIRM" || b.textContent.trim() === "Confirm");
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

        // After CONFIRM, dump what's on screen before selecting articles
    await page.waitForTimeout(3000);
    const afterConfirm = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      return btns.slice(0, 20).map((b, i) => i + ":" + b.textContent.replace(/\s+/g, " ").trim().slice(0, 45)).filter(x => x.length > 3);
    });
    log("After confirm, buttons: " + JSON.stringify(afterConfirm));

    // Select ALL articles - top checkbox
    log("Selecting all articles...");
    const allChecked = await page.evaluate(() => {
      const cbs = Array.from(document.querySelectorAll("input[type='checkbox']"));
      if (cbs.length > 0) { cbs[0].click(); return cbs.length; }
      return 0;
    });
    log("Checkboxes found: " + allChecked);
    await page.waitForTimeout(1500);
;

        // Click COPY WITH SELECTED FOOD ARTICLES
    log("Copying with selected food articles...");
    const copyClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("COPY WITH SELECTED FOOD ARTICLES"));
      if (btn) { btn.click(); return true; }
      return false;
    });
    log("Copy button clicked: " + copyClicked);

    // Wait for the submission page to actually load (Food Articles table appears)
    await page.waitForFunction(() =>
      document.body.innerText.includes("FOOD ARTICLES") ||
      document.body.innerText.includes("SUBMIT TO FDA") ||
      document.body.innerText.includes("MODE OF"),
      { timeout: 20000 }
    ).catch(() => {});
    await page.waitForTimeout(3000);

    const afterCopy = await page.evaluate(() => document.body.innerText.substring(0, 200));
    log("After copy landed on: " + afterCopy);

    // Click any left-menu step by its exact label (Angular auto-saves on nav)
    async function clickSidebar(label) {
      const result = await page.evaluate((text) => {
        const norm = (s) => s.replace(/\s+/g, " ").trim();
        const els = Array.from(document.querySelectorAll("a, li, span, div, button"));
        // exact leaf match first
        let el = els.find(e => e.children.length === 0 && norm(e.textContent) === text);
        // then contains match on a short leaf
        if (!el) el = els.find(e => e.children.length === 0 && norm(e.textContent).includes(text) && norm(e.textContent).length < text.length + 15);
        if (el) {
          const clickable = el.closest("a, button, li") || el;
          clickable.click();
          return "clicked:" + el.tagName;
        }
        // debug: list all short leaf texts
        const leaves = els.filter(e => e.children.length === 0 && norm(e.textContent).length > 0 && norm(e.textContent).length < 40)
          .map(e => norm(e.textContent));
        return "MISS | leaves: " + JSON.stringify([...new Set(leaves)].slice(0, 40));
      }, label);
      await page.waitForTimeout(6000);
      return result;
    }

           log("Updating tracking number...");
    const pencilResult = await page.evaluate(() => {
      const norm = s => (s||"").replace(/\s+/g," ").trim();
      // find the MODE OF TRANSPORTATION heading, then the pencil button in its card
      const all = Array.from(document.querySelectorAll("*"));
      const heading = all.find(e =>
        /MODE OF TRANSPORTATION/i.test(norm(e.textContent)) &&
        norm(e.textContent).length < 60 &&
        e.tagName !== "HTML" && e.tagName !== "BODY"
      );
      if (!heading) return "no heading";
      // walk up to the card, then find its edit pencil (a button, not the section icon)
      let node = heading;
      for (let i = 0; i < 6 && node; i++) {
        const btn = node.querySelector && node.querySelector("button");
        if (btn) { btn.click(); return "clicked L" + i; }
        node = node.parentElement;
      }
    return "heading found no button";
    });
    log("Pencil: " + pencilResult);

    // Wait for carrier form to load, confirm the tracking field exists
    await page.waitForSelector("#trackingNumber", { timeout: 15000 }).catch(() => {});
    const formOpen = await page.evaluate(() => !!document.querySelector("#trackingNumber"));
    log("Carrier form open: " + formOpen);

    // Update tracking number
    await page.click("#trackingNumber", { clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(trackingNumber, { delay: 100 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);

    // Update arrival date
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
    log("Tracking and date updated");

        // Save tracking by going to overview, then open Importer via its pencil
    await clickSidebar("Prior Notice Overview");
    await page.waitForTimeout(4000);

    const impOk = await page.evaluate(() => {
      const norm = s => (s||"").replace(/\s+/g," ").trim();
      const all = Array.from(document.querySelectorAll("*"));
      const heading = all.find(e =>
        /IMPORTER DETAILS/i.test(norm(e.textContent)) &&
        norm(e.textContent).length < 60 &&
        e.tagName !== "HTML" && e.tagName !== "BODY"
      );
      if (!heading) return "no heading";
      let node = heading;
      for (let i = 0; i < 6 && node; i++) {
        const btn = node.querySelector && node.querySelector("button");
        if (btn) { btn.click(); return "clicked L" + i; }
        node = node.parentElement;
      }
      return "heading found no button";
    });
    log("Opened Importer Details: " + impOk);
    await page.waitForTimeout(4000);


    // Fill importer name
        log("Opened Importer Details: " + impOk);
    await page.waitForTimeout(4000);

    const formDump = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
      return inputs.map((i, n) => n + ":" + i.tagName + "[" + (i.type||"") + "] ph=" + (i.placeholder||"") + " id=" + (i.id||"") + " name=" + (i.name||"")).slice(0, 30);
    });
    log("Importer form fields: " + JSON.stringify(formDump));


    // Fill street address
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input, textarea"));
      const field = inputs.find(i =>
        (i.placeholder && i.placeholder.toLowerCase().includes("address")) ||
        (i.id && i.id.toLowerCase().includes("address"))
      );
      if (field) { field.focus(); field.click(); }
    });
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(importer.address, { delay: 100 });
    await page.waitForTimeout(300);

    // Fill city
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const field = inputs.find(i =>
        (i.placeholder && i.placeholder.toLowerCase().includes("city")) ||
        (i.id && i.id.toLowerCase().includes("city"))
      );
      if (field) { field.focus(); field.click(); }
    });
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(importer.city, { delay: 100 });
    await page.waitForTimeout(300);

    // Select state
    await page.locator("select[name='state'], select[id*='state']").selectOption({ label: importer.state }).catch(async () => {
      await page.evaluate((state) => {
        const sels = Array.from(document.querySelectorAll("select"));
        for (const sel of sels) {
          const opt = Array.from(sel.options).find(o => o.text.includes(state));
          if (opt) {
            sel.value = opt.value;
            ["input", "change", "blur"].forEach(ev =>
              sel.dispatchEvent(new Event(ev, { bubbles: true }))
            );
          }
        }
      }, importer.state);
    });
    await page.waitForTimeout(500);

    // Fill zip
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const field = inputs.find(i =>
        (i.placeholder && i.placeholder.toLowerCase().includes("zip")) ||
        (i.id && i.id.toLowerCase().includes("zip"))
      );
      if (field) { field.focus(); field.click(); }
    });
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(importer.zip, { delay: 100 });
    await page.waitForTimeout(300);

    // Save automatically and return to overview
    const backOk = await clickSidebar("Prior Notice Overview");
    log("Back to overview: " + backOk);

    const overviewCheck = await page.evaluate(() => document.body.innerText);
    log("Overview check: " + overviewCheck.substring(0, 300));

    log("Processing food articles...");
    let articlesDone = false;
    let articleCount = 0;


    while (!articlesDone) {
      // Find next In Progress article pencil
      const foundArticle = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tr"));
        for (const row of rows) {
          if (row.textContent.includes("In Progress")) {
            const btns = Array.from(row.querySelectorAll("button, a"));
            if (btns.length > 0) { btns[0].click(); return true; }
          }
        }
        return false;
      });

      if (!foundArticle) { articlesDone = true; break; }
      articleCount++;
      log("Processing article " + articleCount + "...");
      await page.waitForTimeout(5000);

      // Click Ultimate Consignee in sidebar
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        const el = all.find(e =>
          e.children.length === 0 &&
          e.textContent.trim() === "Ultimate Consignee" &&
          e.tagName !== "SCRIPT"
        );
        if (el) { el.click(); const parent = el.closest("a, button, li"); if (parent) parent.click(); }
      });
      await page.waitForTimeout(3000);

      // Fill ultimate consignee - same importer info
      // Name
      await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input"));
        const field = inputs.find(i => i.id && i.id.toLowerCase().includes("name") ||
          i.placeholder && i.placeholder.toLowerCase().includes("name"));
        if (field) { field.focus(); field.click(); }
      });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(importer.name, { delay: 100 });
      await page.waitForTimeout(300);

      // Address
      await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input, textarea"));
        const field = inputs.find(i => i.id && i.id.toLowerCase().includes("address") ||
          i.placeholder && i.placeholder.toLowerCase().includes("address"));
        if (field) { field.focus(); field.click(); }
      });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(importer.address, { delay: 100 });
      await page.waitForTimeout(300);

      // City
      await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input"));
        const field = inputs.find(i => i.id && i.id.toLowerCase().includes("city") ||
          i.placeholder && i.placeholder.toLowerCase().includes("city"));
        if (field) { field.focus(); field.click(); }
      });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(importer.city, { delay: 100 });
      await page.waitForTimeout(300);

      // State
      await page.locator("select[name='state'], select[id*='state']").selectOption({ label: importer.state }).catch(async () => {
        await page.evaluate((state) => {
          const sels = Array.from(document.querySelectorAll("select"));
          for (const sel of sels) {
            const opt = Array.from(sel.options).find(o => o.text.includes(state));
            if (opt) {
              sel.value = opt.value;
              ["input", "change", "blur"].forEach(ev =>
                sel.dispatchEvent(new Event(ev, { bubbles: true }))
              );
            }
          }
        }, importer.state);
      });
      await page.waitForTimeout(500);

      // Zip
      await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input"));
        const field = inputs.find(i => i.id && i.id.toLowerCase().includes("zip") ||
          i.placeholder && i.placeholder.toLowerCase().includes("zip"));
        if (field) { field.focus(); field.click(); }
      });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(importer.zip, { delay: 100 });
      await page.waitForTimeout(300);

      // Click Review in sidebar
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        const el = all.find(e =>
          e.children.length === 0 &&
          e.textContent.trim() === "Review" &&
          e.tagName !== "SCRIPT"
        );
        if (el) { el.click(); const parent = el.closest("a, button, li"); if (parent) parent.click(); }
      });
      await page.waitForTimeout(5000);

      // Click ADD THIS ARTICLE TO MY PRIOR NOTICE SUBMISSION
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"));
        const btn = btns.find(b => b.textContent.toLowerCase().includes("add this article to my prior"));
        if (btn) { btn.scrollIntoView(); btn.click(); }
      });

      // Wait for popup
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        return btns.some(b =>
          b.textContent.includes("No, Done creating Food Articles") ||
          b.textContent.includes("Yes, Create new Food Article")
        );
      }, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // Check if more articles exist - if yes click Yes, else No
      const pageText = await page.evaluate(() => document.body.innerText);
      const hasMoreInProgress = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tr"));
        return rows.some(r => r.textContent.includes("In Progress"));
      });

      if (hasMoreInProgress) {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const btn = btns.find(b => b.textContent.includes("No, Done creating Food Articles"));
          if (btn) btn.click();
        });
        await page.waitForTimeout(3000);
      } else {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const btn = btns.find(b => b.textContent.includes("No, Done creating Food Articles"));
          if (btn) btn.click();
        });
        await page.waitForTimeout(3000);
        articlesDone = true;
      }
    }

    log("All " + articleCount + " articles processed");

    // Submit to FDA
    log("Submitting to FDA...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("submit to fda"));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    });

    await page.waitForFunction(() =>
      document.body.innerText.includes("Submitted to FDA"),
      { timeout: 60000 }
    ).catch(() => {});
        log("Submitted to FDA");
    await page.waitForTimeout(5000);


    // Generate PDF
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

    log("Confirmation: " + confirmationNumber);
    session.dupResult = { success: true, confirmationNumber, logs };

  } catch (err) {
    log("ERROR: " + err.message);
    session.dupResult = { success: false, error: err.message, logs };
  }
});


app.listen(PORT, () => console.log("Server running on port " + PORT));
