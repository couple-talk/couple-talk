// Status chips: the built-in six plus the ones I made (#12), kept on this PC only. Both travel as the same
// `status` payload, so a made-up status reaches an older app on the other side unchanged.
import { net, sendPayload } from './chat';
import { STATUSES } from './protocol';
import { bindForm } from './setup';
import { $, config, load, save } from './state';

type Status = readonly [emoji: string, text: string, pose?: string];
const mine = load<Status[]>('ct.statuses', []);
const dialog = $<HTMLDialogElement>('#status-dialog');
const segmenter = new Intl.Segmenter();

function chip([emoji, text, pose]: Status, remove?: () => void) {
  const b = document.createElement('button');
  b.textContent = `${emoji} ${text}`;
  b.onclick = () => sendPayload({ type: 'status', emoji, text, pose });
  if (remove) {
    b.title = '우클릭으로 지우기';
    b.oncontextmenu = (e) => { e.preventDefault(); remove(); };
  }
  return b;
}

const add = document.createElement('button');
add.textContent = '＋';
add.title = '상태 만들기';
add.onclick = () => { dialog.querySelector('.error')!.textContent = ''; dialog.showModal(); };

function render() {
  const own = mine.map((s, i) => chip(s, () => { mine.splice(i, 1); save('ct.statuses', mine); render(); }));
  $('#statuses').replaceChildren(...STATUSES.map((s) => chip(s)), ...own, add);
}
render();

// Pose choices: none (the pet stands as usual) or one of the six status poses, shown by their built-in emoji.
$('#status-poses').append(...[['', '없음'], ...STATUSES.map(([emoji, , pose]) => [pose, emoji])].map(([value, label], i) => {
  const l = document.createElement('label');
  l.append(Object.assign(document.createElement('input'), { type: 'radio', name: 'pose', value, checked: i === 0 }), ` ${label}`);
  return l;
}));

// Scheduled 퇴근 (#12): past the set time on a weekday, once a day, while the app is running and connected.
// `>=` rather than `===` so a PC asleep at that minute still sends when it wakes (and so does opening the app later that evening).
const OFF = STATUSES.find((s) => s[2] === 'status_off')!;
setInterval(async () => {
  const at = config?.offAt;
  if (!at || !net) return;
  const now = new Date();
  const today = now.toDateString();
  if (now.getDay() % 6 === 0 || now.toTimeString().slice(0, 5) < at || load('ct.offSent', '') === today) return;
  if (await sendPayload({ type: 'status', emoji: OFF[0], text: OFF[1], pose: OFF[2] })) save('ct.offSent', today);
}, 30_000);

bindForm('#status-form', async (f) => {
  const emoji = String(f.get('emoji')).trim();
  const text = String(f.get('text')).trim();
  const pose = String(f.get('pose')) || undefined;
  if ([...segmenter.segment(emoji)].length !== 1) throw new Error('이모지는 하나만 넣어 주세요');
  if (!text) throw new Error('문구를 입력해 주세요');
  // Same emoji and phrase again: keep one chip, with the pose chosen this time.
  const i = mine.findIndex(([e, t]) => e === emoji && t === text);
  mine.splice(i < 0 ? mine.length : i, 1, [emoji, text, pose]);
  save('ct.statuses', mine);
  render();
  $<HTMLFormElement>('#status-form').reset();
  dialog.close();
  await sendPayload({ type: 'status', emoji, text, pose });
});
