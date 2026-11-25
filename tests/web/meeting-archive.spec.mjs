import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../web/', import.meta.url));
let vite;
let origin;

test.beforeAll(async () => {
  vite = await createServer({root, configFile:false, appType:'custom', optimizeDeps:{noDiscovery:true},
    server:{host:'127.0.0.1',port:0,watch:null,preTransformRequests:false}});
  vite.middlewares.use((request, response, next) => {
    if (request.url !== '/archive-test') return next();
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>리플레이 테스트</title>');
  });
  await vite.listen();
  origin = new URL(vite.resolvedUrls.local[0]);
});

test.afterAll(async () => { await vite?.close(); });

test('preserves a gap and sample positions across storage chunks and page reload', async ({ page }) => {
  await page.goto(new URL('/archive-test', origin).href);
  await page.evaluate(async () => {
    const {createMeetingArchive} = await import('/meeting-archive.ts');
    const archive = createMeetingArchive('meeting-archive-a');
    const frame = (value) => {
      const pcm = new Uint8Array(960);
      const samples = new DataView(pcm.buffer);
      for (let i = 0; i < pcm.length; i += 2) samples.setInt16(i, value, true);
      return btoa(String.fromCharCode(...pcm));
    };
    // First frame crosses the 4 s chunk boundary; there is no audio at 4.02 s.
    archive.appendFrame(95_760, frame(213));
    archive.appendFrame(96_720, frame(-542));
    if (!await archive.finish()) throw Error('archive was not persisted');
    const other = createMeetingArchive('meeting-archive-b');
    other.appendFrame(95_760, frame(999));
    await other.finish();
  });
  await page.reload();
  const played = await page.evaluate(async () => {
    const {hasMeetingArchive, readMeetingAudio, removeMeetingArchive} = await import('/meeting-archive.ts');
    const wav = await readMeetingAudio('meeting-archive-a', 3995, 5000);
    const all = await wav.arrayBuffer();
    const info = new DataView(all);
    const prefix = await readMeetingAudio('meeting-archive-a', 3995, 4050, {stopAtGap:true});
    const sample = (index) => info.getInt16(44 + index * 2, true);
    const result = {
      format: wav.type,
      fileType: new TextDecoder().decode(all.slice(0, 4)),
      channels: info.getUint16(22, true),
      rate: info.getUint32(24, true),
      size: info.getUint32(40, true),
      samples: [0, 359, 360, 839, 840, 1319].map(sample),
      gap: await readMeetingAudio('meeting-archive-a', 4010, 4030) === undefined,
      crossingChunkAllowed: !!await readMeetingAudio('meeting-archive-a', 3995, 4010,
        {minimumCapturedMs:15, requireContinuous:true}),
      crossingGapDenied: !await readMeetingAudio('meeting-archive-a', 3995, 4050,
        {minimumCapturedMs:20, requireContinuous:true}),
      prefixBytes: new DataView(await prefix.arrayBuffer()).getUint32(40, true),
      prefixStartsInGap: !!await readMeetingAudio('meeting-archive-a', 4010, 4050, {stopAtGap:true}),
      tooLittleCapture: !await readMeetingAudio('meeting-archive-a', 3995, 4050,
        {minimumCapturedMs:35.01}),
    };
    await removeMeetingArchive('meeting-archive-a');
    return {...result, removed: !await hasMeetingArchive('meeting-archive-a'), other: await hasMeetingArchive('meeting-archive-b')};
  });
  expect(played).toEqual({format:'audio/wav',fileType:'RIFF',channels:1,rate:24000,size:2640,
    samples:[213,213,0,0,-542,-542],gap:true,crossingChunkAllowed:true,crossingGapDenied:true,
    prefixBytes:720,prefixStartsInGap:false,tooLittleCapture:true,removed:true,other:true});
});

test('does not publish an empty or abandoned archive', async ({ page }) => {
  await page.goto(new URL('/archive-test', origin).href);
  const status = await page.evaluate(async () => {
    const {createMeetingArchive, hasMeetingArchive} = await import('/meeting-archive.ts');
    const empty = createMeetingArchive('empty-archive');
    const abandoned = createMeetingArchive('abandoned-archive');
    const pcm = btoa('\u0001'.repeat(960));
    abandoned.appendFrame(0, pcm);
    abandoned.appendFrame(97_000, pcm); // Queues a write before discarding.
    await abandoned.discard();
    return [await empty.finish(), await hasMeetingArchive('empty-archive'), await hasMeetingArchive('abandoned-archive')];
  });
  expect(status).toEqual([false,false,false]);
});

test('normal teardown retains the recording and overlapping reconnected frames keep earlier audio', async ({ page }) => {
  await page.goto(new URL('/archive-test', origin).href);
  const result = await page.evaluate(async () => {
    const {createMeetingArchive, readMeetingAudio} = await import('/meeting-archive.ts');
    const archive = createMeetingArchive('overlap-archive');
    archive.appendFrame(0, btoa('\u0001\u0000'.repeat(480)));
    archive.appendFrame(240, btoa('\u0002\u0000'.repeat(480)));
    const finished = archive.finish();
    await archive.discardIfUnfinished();
    await finished;
    const wav = await readMeetingAudio('overlap-archive', 0, 30, {minimumCapturedMs:30, requireContinuous:true});
    const view = new DataView(await wav.arrayBuffer());
    return [0,239,240,479,480,719].map(i => view.getInt16(44+i*2, true));
  });
  expect(result).toEqual([1,1,1,1,2,2]);
});

test('whole-meeting windows outlast preview limits and preserve silent gaps on the original timeline', async ({ page }) => {
  await page.goto(new URL('/archive-test', origin).href);
  const result = await page.evaluate(async () => {
    const {createMeetingArchive, meetingAudioDuration, readMeetingAudioWindow, removeMeetingArchive} = await import('/meeting-archive.ts');
    const archive = createMeetingArchive('long-archive');
    archive.appendFrame(0, btoa('\u0001\u0000'.repeat(480)));
    archive.appendFrame(1_800_000, btoa('\u0002\u0000'.repeat(480)));
    await archive.finish();
    const duration = await meetingAudioDuration('long-archive');
    const bytes = async (from, to) => new DataView(await (await readMeetingAudioWindow('long-archive',from,to)).arrayBuffer());
    const empty = await bytes(10_000, 12_000);
    const tail = await bytes(74_990, duration);
    await removeMeetingArchive('long-archive');
    return {duration, emptyFrames:empty.getUint32(40,true) / 2,
      emptyEnergy:new Uint8Array(empty.buffer,44).some(Boolean),
      tailFrames:tail.getUint32(40,true)/2, tailSamples:[0,239,240,719].map(i => tail.getInt16(44 + i*2,true)),
      removed:await meetingAudioDuration('long-archive') === undefined};
  });
  expect(result).toEqual({duration:75020,emptyFrames:48000,emptyEnergy:false,tailFrames:720,tailSamples:[0,0,2,2],removed:true});
});
