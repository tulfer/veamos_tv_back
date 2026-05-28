$ErrorActionPreference = 'Stop'
Set-Location C:\workspace\veamos_tv_back

# Write a quick script to dump DOM
@"
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.cineby.sc/es', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Dump all h2 and h3 elements with parent info
  const result = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('h2, h3').forEach(h => {
      const parent = h.parentElement;
      const grandparent = parent?.parentElement;
      const cls = h.className;
      const parentCls = parent?.className || '';
      const gpCls = grandparent?.className || '';
      const pt = parent?.tagName || '';
      const gpt = grandparent?.tagName || '';
      items.push({
        tag: h.tagName,
        text: h.textContent?.trim().slice(0, 60),
        class: cls,
        parentTag: pt,
        parentClass: parentCls,
        grandparentTag: gpt,
        grandparentClass: gpCls,
      });
    });
    return items;
  });

  console.log(JSON.stringify(result, null, 2));
  
  // Also dump first 3 section containers' innerHTML
  const sectionHtml = await page.evaluate(() => {
    // Find potential section containers
    const containers = document.querySelectorAll('[class*="section"], [class*="container"], [class*="slider"], [class*="carousel"], section');
    const results = [];
    containers.forEach(c => {
      const h = c.querySelector('h2, h3');
      if (h) {
        const name = h.textContent?.trim().slice(0, 40);
        results.push({
          heading: name,
          class: c.className.slice(0, 100),
          tag: c.tagName,
          childCount: c.children.length,
          html: c.innerHTML.slice(0, 2000),
        });
      }
    });
    return results.slice(0, 8);
  });

  console.log('--- SECTION HTML ---');
  console.log(JSON.stringify(sectionHtml, null, 2));

  await browser.close();
})();
"@ | Out-File -FilePath C:\workspace\veamos_tv_back\data\inspect-cineby.mjs -Encoding utf8

npx tsx data\inspect-cineby.mjs 2>&1
