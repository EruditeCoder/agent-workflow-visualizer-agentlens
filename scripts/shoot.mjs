import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.argv[2] || "shot.png";
const PARAM = process.argv[3] || "";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1900,1000"],
  defaultViewport: { width: 1900, height: 1000 },
});
const page = await browser.newPage();
await page.goto("http://localhost:5180/" + PARAM, { waitUntil: "networkidle0" });
await page.waitForSelector(".react-flow__node", { timeout: 10000 });
await new Promise((r) => setTimeout(r, 1800)); // dagre + fitView settle

const clickText = (process.argv.find((a) => a.startsWith("--click=")) || "").slice(8);
if (clickText) {
  await page.evaluate((txt) => {
    if (txt.startsWith("chip:")) {
      const name = txt.slice(5);
      const chip = [...document.querySelectorAll(".tool-chip")].find((c) =>
        c.querySelector(".chip-name")?.textContent.includes(name),
      );
      if (chip) chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return;
    }
    const titles = [...document.querySelectorAll(".node-card .title")];
    const hit = titles.find((t) => t.textContent.includes(txt));
    if (hit) hit.closest(".react-flow__node").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, clickText);
  await new Promise((r) => setTimeout(r, 1200));
}

await page.screenshot({ path: OUT });
console.log("wrote", OUT);
await browser.close();
