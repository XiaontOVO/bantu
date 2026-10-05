import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const impressions = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-impressions.js')).href);
const components = await import(pathToFileURL(join(process.cwd(), 'public/lib/components.js')).href);
const demoPlaces = await import(pathToFileURL(join(process.cwd(), 'dist/src/demo/demo-data.js')).href);
const staticFiles = await import(pathToFileURL(join(process.cwd(), 'dist/src/server/http/static.js')).href);

const localImpressions: Array<[string, string]> = [
  ['武康大楼', 'impression/wukang-1.jpg'],
  ['徐家汇书院', 'impression/xujiahui-library-1.jpg'],
  ['上海图书馆', 'impression/shanghai-library-1.jpg'],
  ['龙华寺', 'impression/longhua-1.jpg'],
  ['西岸美术馆', 'impression/west-bund-museum-impression-1.png'],
  ['徐家汇公园', 'impression/xujiahui-park-1.jpg'],
  ['桂林公园', 'impression/guilin-park-1.jpg'],
  ['光启公园', 'impression/guangqi-park-1.png'],
  ['徐家汇藏书楼', 'impression/bibliotheca-zi-ka-wei-1.png'],
  ['上海气象博物馆（徐家汇观象台）', 'impression/meteorological-museum-1.png'],
  ['宋庆龄故居纪念馆', 'impression/soong-ching-ling-1.png'],
  ['上海交通大学徐汇校区', 'impression/shanghaijiaotonguniversity-1.jpg'],
  ['上海电影博物馆', 'impression/film-museum-1.png'],
  ['上海公安博物馆', 'impression/public-security-museum-1.png'],
  ['上海工艺美术博物馆', 'impression/arts-and-crafts-museum-1.png'],
  ['徐汇艺术馆', 'impression/xuhui-art-museum-1.png'],
  ['巴金故居', 'impression/ba-jin-residence-1.png'],
  ['龙华烈士陵园', 'impression/longhua-martyrs-park-ai-2x1.png'],
  ['龙美术馆（西岸馆）', 'impression/long-museum-west-bund-ai-2x1.png'],
  ['上海摄影艺术中心', 'impression/shanghai-center-of-photography-ai-2x1.png'],
  ['油罐艺术中心', 'impression/tank-art-center-ai-2x1.png'],
  ['西岸梦中心', 'impression/west-bund-dream-center-ai-2x1.png'],
  ['上海植物园', 'impression/shanghai-botanical-garden-ai-2x1.png'],
  ['上海体育场', 'impression/shanghai-stadium-ai-2x1.png'],
  ['上海体育馆', 'impression/shanghai-indoor-stadium-ai-2x1.png'],
  ['土山湾博物馆', 'impression/tushanwan-museum-ai-2x1.png'],
  ['星美术馆', 'impression/start-museum-ai-2x1.png'],
];

test('每张本地地点印象图都映射到目录名称并显示在地点卡片中', async () => {
  for (const [index, [name, relativeFile]] of localImpressions.entries()) {
    const place = { placeId: `impression-${index}`, name, category: 'culture', facilityCodes: [] };
    const impression = impressions.placeImpression(place);
    const src = `/images/places/${relativeFile}`;
    assert.equal(impression.placeholder, false, `${name} 不应退回占位图`);
    assert.equal(impression.src, src, `${name} 应连接到对应的本地印象图`);
    await access(join(process.cwd(), 'public/images/places', relativeFile));

    const html = components.placeCard(place);
    assert.ok(html.includes(`src="${src}"`), `${name} 的印象图应进入产品地点卡片`);
    assert.ok(!html.includes('is-placeholder'), `${name} 的地点卡片不应显示占位状态`);
  }
});

test('产品登记的印象图原文件均为 2:1，旧重绘路径也采用新版插画', async () => {
  for (const [name, file] of localImpressions) {
    const bytes = await readFile(join(process.cwd(), 'public/images/places', file));
    let width = 0, height = 0;
    if (bytes.subarray(1, 4).toString() === 'PNG') {
      width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    } else {
      assert.equal(bytes.readUInt16BE(0), 0xffd8, `${name} 的 JPEG 签名`);
      let offset = 2;
      while (offset < bytes.length) {
        assert.equal(bytes[offset], 0xff);
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
        }
        if (marker === 0xda || marker === 0xd9) break;
        offset += bytes.readUInt16BE(offset);
      }
    }
    assert.ok(width > 0 && height > 0, `${name} 应可读取图片尺寸`);
    assert.equal(width, height * 2, `${name} 原图 ${width}×${height} 应为 2:1`);
    if (file.endsWith('-ai-2x1.png')) {
      const oldPath = `/images/places/${file.replace('-ai-2x1.png', '-1.jpg')}`;
      const legacy = impressions.placeImpression({ name: '历史自定义名称', impressionImage: `${oldPath}?rev=old` });
      assert.equal(legacy.src, `/images/places/${file}?rev=old`);
    }
  }
  const placeholder = impressions.placeImpression({ name: '尚无印象图的新地点' });
  const svg = decodeURIComponent(placeholder.src.split(',', 2)[1]);
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.ok(box);
  assert.equal(Number(box[1]), Number(box[2]) * 2, '占位图也应保持 2:1');
});

test('本地图别名和 PNG、自定义 WebP 路径可用，外部及越界路径仍被拒绝', () => {
  assert.equal(impressions.placeImpression({ name: '上海气象博物馆' }).src, '/images/places/impression/meteorological-museum-1.png');
  assert.equal(impressions.placeImpression({ name: '上海交通大学' }).src, '/images/places/impression/shanghaijiaotonguniversity-1.jpg');
  assert.equal(impressions.placeImpression({ name: '自定义地点', impressionImage: '/images/places/impression/guangqi-park-1.png' }).placeholder, false);
  assert.equal(impressions.placeImpression({ name: '自定义地点', impressionImage: '/images/places/photos/custom.webp' }).src, '/images/places/photos/custom.webp');
  assert.equal(impressions.placeImpression({ name: '自定义地点', impressionImage: 'https://example.com/impression.png' }).placeholder, true);
  assert.equal(impressions.placeImpression({ name: '自定义地点', impressionImage: '/images/places/%2e%2e/private.png' }).placeholder, true);
});

test('样例地点覆盖的印象图路径全部能由产品静态目录读取', async () => {
  const mapped = demoPlaces.DEMO_SHANGHAI_PLACES
    .map((place: { name: string; impressionImage?: string }) => ({ place, impression: impressions.placeImpression(place) }))
    .filter(({ impression }: { impression: { placeholder: boolean } }) => !impression.placeholder);
  assert.equal(mapped.length, demoPlaces.DEMO_SHANGHAI_PLACES.length, '每个样例地点都应连接到本地印象图，不回退通用占位图');
  assert.equal(mapped.length, localImpressions.length, '样例目录的本地印象图应与素材登记数量一致');
  for (const { place, impression } of mapped) {
    assert.ok(impression.src.startsWith('/images/places/'), `${place.name} 应使用本地印象图`);
    assert.equal(staticFiles.isStaticPath(impression.src), true, `${place.name} 图片路径应可由产品静态服务识别`);
    await access(join(process.cwd(), 'public', impression.src.replace(/^\//, '')));
    const html = components.placeCard(place);
    assert.ok(html.includes(`src="${impression.src}"`), `${place.name} 的目录卡片应引用实际印象图`);
    assert.ok(!html.includes('is-placeholder'), `${place.name} 的目录卡片不应退回占位图`);
  }
});

test('西岸美术馆印象图连接本地自绘插画，实拍照片保持独立且可读取', async () => {
  const westBund = demoPlaces.DEMO_SHANGHAI_PLACES.find((place: { name: string }) => place.name === '西岸美术馆');
  assert.ok(westBund, '样例目录应包含西岸美术馆');

  const impression = impressions.placeImpression(westBund);
  assert.equal(impression.src, '/images/places/impression/west-bund-museum-impression-1.png');
  const staleWestBund = impressions.placeImpression({
    ...westBund,
    impressionImage: '/images/places/impression/westbund-1.jpg',
  });
  assert.equal(staleWestBund.src, impression.src, '过期地点记录不能把西岸美术馆印象图覆盖到错误路径');
  for (const legacyPath of [
    '/images/places/impression/westbund-1.jpg',
    '/images/places/impression/west-bund-museum-impression-1.jpg',
  ]) {
    const legacyPlace = impressions.placeImpression({ name: '西岸滨江展馆旧记录', impressionImage: legacyPath });
    assert.equal(legacyPlace.src, impression.src, `旧印象图路径 ${legacyPath} 应归一到真实 PNG 路径`);
  }
  const staleCard = components.placeCard({
    ...westBund,
    impressionImage: '/images/places/impression/westbund-1.jpg',
  });
  assert.ok(staleCard.includes(`src="${impression.src}"`), '地点卡片应始终渲染西岸美术馆对应的印象图');
  assert.ok(!staleCard.includes('src="/images/places/impression/westbund-1.jpg"'), '地点卡片不应渲染过期别名路径');
  const impressionBytes = await readFile(join(process.cwd(), 'public', impression.src.replace(/^\//, '')));
  assert.deepEqual([...impressionBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], '西岸美术馆自绘印象插画应是签名正确的 PNG');
  assert.equal(westBund.photos?.[0]?.src, '/images/places/photos/westbund-2.jpg', '馆舍实拍照仍在详情照片中单独展示');
  assert.notEqual(westBund.photos?.[0]?.src, impression.src, '印象插画不应错误链接到实拍照片');
  const cardHtml = components.placeCard(westBund);
  assert.ok(cardHtml.includes(`src="${impression.src}"`), '西岸美术馆地点卡片应展示自绘印象插画');

  for (const photo of westBund.photos ?? []) {
    assert.equal(staticFiles.isStaticPath(photo.src), true, `照片路径应可由静态服务读取：${photo.src}`);
    await access(join(process.cwd(), 'public', photo.src.replace(/^\//, '')));
  }
});
