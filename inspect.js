const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:47195/login');
  await page.fill('#username','admin');
  await page.fill('#password','Opal@2026');
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(2000);
  await page.goto('http://127.0.0.1:47195/inventory/barcode');
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[title="Label preview"]');
    return { iframeWidth: iframe && iframe.style.width, iframeHeight: iframe && iframe.style.height, transform: iframe && iframe.style.transform };
  });
  console.log(JSON.stringify(info));
  await browser.close();
})();
