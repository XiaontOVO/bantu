// Render the existing local SVG mark, without introducing a different video logo.
import {readFileSync,writeFileSync} from 'node:fs';
import {launchMobileBrowser} from './lib/mobile-browser.mjs';
const browser=await launchMobileBrowser('bantu-video-brand-');
try{
 await browser.viewport(64,64);
 const frameId=(await browser.command('Page.getFrameTree')).frameTree.frame.id;
 const data=Buffer.from(readFileSync('public/icon.svg')).toString('base64');
 await browser.command('Page.setDocumentContent',{frameId,html:`<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:transparent"><img width="64" height="64" src="data:image/svg+xml;base64,${data}">`});
 await browser.until(()=>browser.evaluate('document.querySelector("img").complete'));
 await browser.command('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
 const result=await browser.command('Page.captureScreenshot',{format:'png'});
 writeFileSync('tmp/bantu-demo-brand.png',Buffer.from(result.data,'base64'));
 console.log('Rendered existing product brand icon.');
}finally{await browser.close()}
