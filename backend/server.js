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
    // Focus the OTP input field specifically
    const otpFocused = await session.page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const otpInput = inputs.find(i => i.placeholder === "Enter Code Here");
      if (otpInput) { otpInput.focus(); otpInput.click(); return "Focused OTP field"; }
      return "OTP field not found";
    });
    console.log("OTP input focus:", otpFocused);
    await session.page.keyboard.press("Control+A");
    await session.page.keyboard.press("Backspace");
    await session.page.keyboard.type(otp, { delay: 150 });
    await session.page.waitForTimeout(1000);

    // Click Submit Code button
    await session.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find(b => b.textContent.trim() === "Submit Code");
      if (btn) btn.click();
    });
    await session.page.waitForTimeout(3000);

    const afterOtp = await session.page.evaluate(() => document.body.innerText);
    console.log("Page after Submit Code:", afterOtp.substring(0, 200));

    // Click "Continue with Password" to skip passkey
    await session.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button"));
      const btn = links.find(b => b.textContent.toLowerCase().includes("continue with password"));
      if (btn) btn.click();
    }).catch(() => {});

    // Wait for OAA page to load
    await session.page.waitForFunction(() =>
      document.body.innerText.includes("Prior Notice System Interface"),
      { timeout: 30000 }
    ).catch(() => {});
    await session.page.waitForTimeout(2000);

    const afterLogin = await session.page.evaluate(() => document.body.innerText);
    console.log("Page after OTP login:", afterLogin.substring(0, 200));

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
    // After OTP login we're already on OAA - just wait for it to fully load
    await page.waitForTimeout(5000);
    const currentPage = await page.evaluate(() => document.body.innerText);
    log("Current page: " + currentPage.substring(0, 150));

    // Click Prior Notice System Interface link
    const clicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const link = links.find(l => 
        l.textContent.trim() === "Prior Notice System Interface" &&
        !l.closest("footer")
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
      if (yes) { yes.click(); }
    }).catch(() => {});
    await page.waitForTimeout(3000);

    const pnsiPage = await page.evaluate(() => document.body.innerText);
    log("PNSI page: " + pnsiPage.substring(0, 150));

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
    // Click Air button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.trim() === "Air");
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);

    // Select Express Courier - Air from dropdown
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes("Express Courier - Air"));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    await page.waitForTimeout(1000);

    // Type IATA code FX
    const iataInput = await page.$("input[placeholder*='IATA'], input[placeholder*='iata']");
    if (iataInput) {
      await iataInput.click({ clickCount: 3 });
      await iataInput.type("FX", { delay: 100 });
      await page.waitForTimeout(500);
      // Click Find Code button
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find(b => b.textContent.includes("Find Code") || b.textContent.includes("FIND CODE"));
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);
    }
    log("IATA typed and Find Code clicked");

    // Type tracking number
    const trackingNumber = invoice.trackingNumber || invoice.invoiceNumber || "";
    const trackInput = await page.$("input[placeholder*='racking'], input[placeholder*='irway']");
    if (trackInput) {
      await trackInput.click({ clickCount: 3 });
      await trackInput.type(trackingNumber, { delay: 100 });
    }
    await page.waitForTimeout(500);

    // Select Tennessee state
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes("Tennessee"));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    await page.waitForTimeout(2000);

    // Select Memphis port
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => o.text.includes("Memphis"));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    });
    await page.waitForTimeout(500);

    // Set arrival date using input
    const arrivalDate = new Date();
    arrivalDate.setDate(arrivalDate.getDate() + 2);
    const mm = String(arrivalDate.getMonth() + 1).padStart(2, "0");
    const dd = String(arrivalDate.getDate()).padStart(2, "0");
    const yyyy = arrivalDate.getFullYear();
    const dateStr = mm + "/" + dd + "/" + yyyy;
    const dateInput = await page.$("input[type='date'], input[placeholder*='ate']");
    if (dateInput) {
      await dateInput.click({ clickCount: 3 });
      await dateInput.type(dateStr, { delay: 100 });
      await page.keyboard.press("Tab");
    }
    await page.waitForTimeout(500);
    await page.waitForTimeout(2000);
    const carrierInputs = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      return inputs.map(i => i.type + "|" + i.placeholder + "|" + i.id + "|" + i.className.substring(0, 30));
    });
    log("Carrier page inputs: " + JSON.stringify(carrierInputs));

    const carrierSelects = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map(s => s.id + "|" + s.name + "|" + Array.from(s.options).slice(0,3).map(o => o.text).join(","));
    });
    log("Carrier page selects: " + JSON.stringify(carrierSelects));


    // Handle "required fields" popup - click "No, I want to continue to the Submitter Details"
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("No, I want to continue to the Submitter Details"));
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForTimeout(3000);

    const afterCarrier = await page.evaluate(() => document.body.innerText);
    log("After carrier save: " + afterCarrier.substring(0, 100));


        log("Submitter Details - Creating for Myself...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.trim() === "Creating for Myself");
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    const afterMyself = await page.evaluate(() => document.body.innerText);
    log("After Creating for Myself: " + afterMyself.substring(0, 150));

    log("Clicking SAVE & CONTINUE on submitter page...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      // Find the LAST Save & Continue (the one at bottom of submitter form)
      const allBtns = btns.filter(b => b.textContent.includes("SAVE & CONTINUE") || b.textContent.includes("Save & Continue"));
      if (allBtns.length > 0) allBtns[allBtns.length - 1].click();
    });
    await page.waitForTimeout(5000);

    const beforePopup = await page.evaluate(() => document.body.innerText);
    log("Page before popup: " + beforePopup.substring(0, 150));

    const addressResult = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll("input[type='radio']"));
      const originalRadio = radios.find(r => {
        const parent = r.closest("label") || r.parentElement;
        return (parent && parent.textContent.includes("Original Address")) || r.value === "0";
      });
      if (originalRadio) { originalRadio.click(); }
      const btns = Array.from(document.querySelectorAll("button"));
      const okBtn = btns.find(b => b.textContent.trim() === "Ok" || b.textContent.trim() === "OK");
      if (okBtn) { okBtn.click(); return "Clicked Original Address + Ok"; }
      return "No popup found - buttons: " + btns.map(b => b.textContent.trim()).join(", ");
    });
    log("Address result: " + addressResult);

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(4000);

    const pageTitle = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? h1.textContent : document.title;
    });
    log("Reached page: " + pageTitle);

        // Step: Add Food Article
    log("Adding food article...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("ADD FOOD ARTICLE"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);
    const afterAddFood = await page.evaluate(() => document.body.innerText);
    log("After ADD FOOD ARTICLE: " + afterAddFood.substring(0, 100));

    // Click "Copy from a Previous Food Article"
    log("Copying from previous food article...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("Copy from a Previous Food Article"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);
    const afterCopy = await page.evaluate(() => document.body.innerText);
    log("After Copy from Previous: " + afterCopy.substring(0, 150));

            // Select ONLY Grape Molasses food article
    log("Selecting food article checkbox...");
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      // Uncheck all first
      rows.forEach(row => {
        const cb = row.querySelector("input[type='checkbox']");
        if (cb && cb.checked) cb.click();
      });
      // Find and check only the Grape Molasses row
      const targetRow = rows.find(row => row.textContent.includes("Grape Molasses"));
      if (targetRow) {
        const cb = targetRow.querySelector("input[type='checkbox']");
        if (cb) { cb.click(); return; }
      }
      // Fallback: check first checkbox
      const first = document.querySelector("tr input[type='checkbox']");
      if (first) first.click();
    });
    await page.waitForTimeout(1000);


    // Click "COPY FOOD ARTICLE(S) TO PRIOR NOTICE"
    log("Clicking Copy Food Articles button...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.includes("COPY FOOD ARTICLE") || b.textContent.includes("Copy Food Article"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // Click "CONFIRM"
    log("Confirming...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find(b => b.textContent.trim() === "CONFIRM" || b.textContent.trim() === "Confirm");
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);
    const afterConfirm = await page.evaluate(() => document.body.innerText);
    log("After Confirm: " + afterConfirm.substring(0, 150));

                   // Click pencil in the In Progress food article row
    log("Clicking pencil to edit article...");
    await page.waitForTimeout(3000);
    const pencilClicked = await page.evaluate(() => {
      const tableRows = Array.from(document.querySelectorAll("tr"));
      for (const row of tableRows) {
        if (row.textContent.includes("In Progress")) {
          const btns = Array.from(row.querySelectorAll("button, a"));
          // Log all buttons in this row
          const btnInfo = btns.map((b, i) => i + ":" + b.innerHTML.substring(0, 50)).join(" | ");
          console.log("Buttons in In Progress row:", btnInfo);
          // Click the first button (should be pencil/edit)
          if (btns.length > 0) {
            btns[0].click();
            return "Clicked btn[0] in In Progress row, total btns: " + btns.length + " | " + btnInfo.substring(0, 100);
          }
        }
      }
      return "No In Progress row found";
    });
    log("Pencil click result: " + pencilClicked);
    await page.waitForTimeout(5000);
    const afterPencil = await page.evaluate(() => document.body.innerText);
    log("After pencil: " + afterPencil.substring(0, 150));




        // Click "Review" in sidebar
    log("Clicking Review...");
    await page.waitForTimeout(3000);
    const reviewClicked = await page.evaluate(() => {
      // Try clicking the Review link in the left sidebar navigation
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
        return "Clicked Review element: " + reviewEl.tagName + " parent: " + (parent?.tagName || "none");
      }
      return "Review element not found";
    });
    log("Review result: " + reviewClicked);
    await page.waitForTimeout(5000);
    const afterReview = await page.evaluate(() => document.body.innerText);
    log("After Review: " + afterReview.substring(0, 200));

            // Click "ADD THIS ARTICLE TO MY PRIOR NOTICE SUBMISSION"
    log("Adding article to submission...");
    await page.waitForTimeout(2000);
    const addClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
          const btn = btns.find(b => 
        b.textContent.toLowerCase().includes("add this article to my prior")
      );

      if (btn) { 
        btn.scrollIntoView();
        btn.click(); 
        return "Clicked: " + btn.textContent.trim().substring(0, 50); 
      }
      return "Not found, buttons: " + btns.map(b => b.textContent.trim().substring(0, 30)).filter(t => t).join(", ");
    });
      log("Add article result: " + addClicked);
    
    // Wait for popup to appear
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.some(b => b.textContent.includes("No, Done creating Food Articles"));
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Handle "Add Article Confirmation" popup
    log("Handling Add Article Confirmation popup...");

    const popupClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("no, done creating"));
      if (btn) { btn.click(); return "Clicked: " + btn.textContent.trim(); }
      // Log all buttons to see what's available
      return "Not found, buttons: " + btns.map(b => b.textContent.trim().substring(0, 30)).filter(t => t).join(", ");
    });
    log("Popup result: " + popupClicked);
    await page.waitForTimeout(5000);
    const afterDone = await page.evaluate(() => document.body.innerText);
    log("After Done: " + afterDone.substring(0, 150));

        await page.waitForTimeout(5000);

    // Wait for food article status to change to "Added to Prior Notice"
    log("Waiting for food article to be Added to Prior Notice...");
    await page.waitForFunction(() => 
      document.body.innerText.includes("Added to Prior Notice"),
      { timeout: 15000 }
    ).catch(() => {});

    const beforeSubmit = await page.evaluate(() => document.body.innerText);
    log("Before submit status: " + beforeSubmit.substring(0, 300));

    // Click "SUBMIT TO FDA"
    log("Submitting to FDA...");
    await page.waitForTimeout(2000);
    const submitClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const btn = btns.find(b => b.textContent.toLowerCase().includes("submit to fda"));
      if (btn) { btn.scrollIntoView(); btn.click(); return "Clicked: " + btn.textContent.trim(); }
      return "Not found, buttons: " + btns.map(b => b.textContent.trim().substring(0, 25)).filter(t => t).join(", ");
    });
    log("Submit to FDA result: " + submitClicked);
    await page.waitForTimeout(3000);

    // Handle confirmation popup
    const submitPopup = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const confirmBtn = btns.find(b => 
        b.textContent.toLowerCase().includes("confirm") ||
        b.textContent.toLowerCase().includes("yes") ||
        b.textContent.toLowerCase().includes("ok")
      );
      if (confirmBtn) { confirmBtn.click(); return "Clicked: " + confirmBtn.textContent.trim(); }
      return "No popup";
    });
    log("Submit popup: " + submitPopup);
    await page.waitForTimeout(8000);

    const finalPage = await page.evaluate(() => document.body.innerText);
    log("Final page: " + finalPage.substring(0, 300));

    const confirmMatch = finalPage.match(/\d{12}/);
    const confirmationNumber = confirmMatch ? confirmMatch[0] : "Submitted - check PNSI";
    log("Confirmation: " + confirmationNumber);

    res.json({ success: true, logs, confirmationNumber, status: "submitted" });

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

