import QRCode from 'qrcode';
import { createIndexedDbStorage, createSyncCore } from '@sync/core';
import { PlaintextCodec } from '@sync/testkit'; // DEV ONLY
import { createWebRtcTransport } from '../src/index';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const space = new URLSearchParams(location.search).get('space') ?? 'demo';
$('space').textContent = space;

const storage = await createIndexedDbStorage({ name: `webrtc-demo-${space}-${Math.random().toString(36).slice(2, 6)}` });
const core = await createSyncCore({ storage, codecs: [new PlaintextCodec()], spaces: [space] });
const rtc = createWebRtcTransport();
core.addTransport(rtc);

core.on((e) => {
  if (e.kind === 'transport:state') $('status').textContent = e.state;
});
$('status').textContent = rtc.state;

let sessionId = '';
const fail = (e: unknown) => ($('error').textContent = e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const show = async (code: string, canvas: string, text: string) => {
  $<HTMLTextAreaElement>(text).value = code;
  await QRCode.toCanvas($<HTMLCanvasElement>(canvas), code, { errorCorrectionLevel: 'L', margin: 1, width: 320 });
};

$('create').onclick = async () => {
  try {
    $('error').textContent = '';
    const offer = await rtc.createOffer();
    sessionId = offer.sessionId;
    await show(offer.code, 'offer-qr', 'offer-text');
  } catch (e) {
    fail(e);
  }
};
$('accept').onclick = async () => {
  try {
    $('error').textContent = '';
    const answer = await rtc.acceptOffer($<HTMLTextAreaElement>('offer-in').value);
    await show(answer.code, 'answer-qr', 'answer-text');
  } catch (e) {
    fail(e);
  }
};
$('connect').onclick = async () => {
  try {
    $('error').textContent = '';
    await rtc.acceptAnswer(sessionId, $<HTMLTextAreaElement>('answer-in').value);
  } catch (e) {
    fail(e);
  }
};

// Camera scanning where the browser can detect QR codes natively.
async function scanInto(target: string): Promise<void> {
  const Detector = (window as unknown as { BarcodeDetector?: new (o: object) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!Detector) return fail('This browser cannot scan QR codes; paste the code instead.');
  const video = $<HTMLVideoElement>('video');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = stream;
  video.style.display = 'block';
  await video.play();
  const detector = new Detector({ formats: ['qr_code'] });
  for (;;) {
    const found = await detector.detect(video);
    if (found[0]?.rawValue.startsWith('SP1.')) {
      $<HTMLTextAreaElement>(target).value = found[0].rawValue;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  stream.getTracks().forEach((t) => t.stop());
  video.style.display = 'none';
}
$('scan-offer').onclick = () => scanInto('offer-in').catch(fail);
$('scan-answer').onclick = () => scanInto('answer-in').catch(fail);

$('add').onclick = async () => {
  const input = $<HTMLInputElement>('note');
  if (!input.value) return;
  await core.create(space, 'note', { text: input.value });
  input.value = '';
};
core.query({ type: 'note' }).subscribe((rows) => {
  $('notes').replaceChildren(
    ...rows.map((r) => Object.assign(document.createElement('li'), { textContent: String(r.fields.text) })),
  );
});
