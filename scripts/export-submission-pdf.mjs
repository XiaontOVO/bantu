// Export the maintained HTML introduction; never read product accounts or keys.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {launchMobileBrowser} from './lib/mobile-browser.mjs';

const html = resolve('docs/作品介绍.html');
const target = resolve('submission/伴途作品介绍.pdf');
const evidence = resolve('tmp/submission-pdf-evidence');
mkdirSync(evidence, {recursive:true});
const browser = await launchMobileBrowser('bantu-submission-pdf-');
try {
  await browser.viewport(1440, 1000);
  await browser.command('Page.navigate', {url:pathToFileURL(html).href});
  await browser.until(() => browser.evaluate("document.readyState === 'complete' && Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)"), 'embedded introduction images');
  await browser.command('Emulation.setEmulatedMedia', {media:'print'});
  await browser.evaluate('document.fonts.ready');
  const layout = await browser.evaluate(`({
    title: document.title,
    pages: document.querySelectorAll('section.slide').length,
    remoteResources: performance.getEntriesByType('resource').filter(entry => /^https?:/.test(entry.name)).map(entry => entry.name)
  })`);
  assert.equal(layout.pages, 8, 'The introduction must contain eight reviewed pages');
  assert.deepEqual(layout.remoteResources, [], 'PDF export must not depend on remote assets');
  assert.deepEqual(browser.exceptions, [], 'Introduction must render without browser exceptions');
  // File links resolved by Chromium would point to this developer's drive on
  // another computer. Keep their visible labels, and preserve public citations.
  const disabledLocalLinks = await browser.evaluate(`Array.from(document.querySelectorAll('a[href]')).filter(link => link.protocol === 'file:').map(link => {
    const label = link.textContent.trim(); link.removeAttribute('href'); return label;
  })`);
  const result = await browser.command('Page.printToPDF', {
    printBackground:true, preferCSSPageSize:true, displayHeaderFooter:false,
    marginTop:0, marginBottom:0, marginLeft:0, marginRight:0,
    transferMode:'ReturnAsBase64', generateTaggedPDF:true,
  });
  const pdf = Buffer.from(result.data, 'base64');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  writeFileSync(target, pdf);
  const proof = {
    html, target, layout, disabledLocalLinks, bytes:pdf.length,
    sourceSha256:createHash('sha256').update(readFileSync(html)).digest('hex'),
    pdfSha256:createHash('sha256').update(pdf).digest('hex'),
    scope:'Local HTML export only; visual PDF inspection follows separately',
  };
  writeFileSync(resolve(evidence, 'export.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  browser.close();
}
