import {useMemo, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {speakerLabel, timeLabel, transcriptText, type RecordData, type Turn} from '../src/records/model.ts';
import {canCorrectMeetingSpeaker, correctMeetingSpeakers, meetingSpeakerTargets,
  undoMeetingSpeakerCorrection, type SpeakerCorrectionChange, type SpeakerTarget} from '../src/records/speaker-correction.ts';
import './speaker-correction.css';

type Props = {
  record: RecordData;
  busy: boolean;
  save(edit:(latest:RecordData) => RecordData): Promise<void>;
  playAt?: (turn:Turn) => ReactNode;
  findSimilar?: (reference:Turn) => Promise<readonly string[]>;
  audioAvailable: boolean;
};

const newTarget = 'new';
const groupPrefix = 'existing:';
const camModelUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';

function SpeakerModelSetup() {
  return <details className="speaker-model-setup">
    <summary>CAM++ 설치 안내</summary>
    <p>모델로 비슷한 목소리의 발언을 찾고 싶을 때만 설치하세요. 발언을 다시 듣고 직접 옮길 때는 필요하지 않습니다.</p>
    <ol>
      <li>Node.js/npm이 설치된 PC에서 아래 명령으로 실행 모듈을 설치합니다.
        <div><strong>Mac 터미널</strong><code>mkdir -p ~/.sitenote/speaker</code><code>npm install --prefix ~/.sitenote/speaker sherpa-onnx-node@2.0.3</code></div>
        <div><strong>Windows PowerShell</strong><code>{'New-Item -ItemType Directory -Force "$HOME/.sitenote/speaker"'}</code>
          <code>{'npm install --prefix "$HOME/.sitenote/speaker" sherpa-onnx-node@2.0.3'}</code></div>
      </li>
      <li>아래 주소를 브라우저 주소창에 붙여넣어 CAM++ 모델을 다운로드합니다.
        <code>{camModelUrl}</code>
      </li>
      <li>다운로드한 파일을 <code>model.onnx</code>로 바꾸고 홈 폴더의 <code>.sitenote/speaker</code>에 넣은 뒤, Sitenote 앱 또는 웹앱 서버를 다시 시작합니다.</li>
    </ol>
  </details>;
}

export function SpeakerCorrection({record,busy,save,playAt,findSimilar,audioAvailable}:Props) {
  const turns = useMemo(() => record.turns.filter(turn => canCorrectMeetingSpeaker(record,turn)),[record]);
  const groups = useMemo(() => meetingSpeakerTargets(record),[record]);
  const [expanded,setExpanded] = useState(false);
  const [onlySelected,setOnlySelected] = useState(false);
  const [selected,setSelected] = useState<ReadonlyMap<string,Turn['speakerId']>>(new Map());
  const [target,setTarget] = useState('');
  const [name,setName] = useState('');
  const [last,setLast] = useState<SpeakerCorrectionChange>();
  const [status,setStatus] = useState('');
  const [error,setError] = useState('');
  const [saving,setSaving] = useState(false);
  const task = useRef(false);

  if (!turns.length) return null;
  const disabled = busy || saving;
  const targetSelected = target === newTarget || groups.some(group => target === groupPrefix + group.id);
  const reference = selected.size === 1 ? turns.find(turn => selected.has(turn.id)) : undefined;

  function toggle(turn:Turn, checked:boolean) {
    setSelected(previous => checked ? new Map([...previous,[turn.id,turn.speakerId]]) :
      new Map([...previous].filter(([id]) => id !== turn.id)));
  }

  async function perform(action: () => Promise<void>) {
    if (busy || task.current) return;
    task.current = true;
    setSaving(true);
    setStatus('');
    setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '화자 변경을 저장하지 못했습니다.'); }
    finally { task.current = false; setSaving(false); }
  }

  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!targetSelected || !selected.size) return;
    const destination: SpeakerTarget = target === newTarget ? {kind:'new',name} :
      {kind:'existing',id:target.slice(groupPrefix.length)};
    const selection = [...selected].map(([id,speakerId]) => ({id,speakerId}));
    void perform(async () => {
      let change: SpeakerCorrectionChange | undefined;
      await save(latest => {
        const result = correctMeetingSpeakers(latest,selection,destination);
        change = result.change;
        return result.record;
      });
      if (!change) {
        setStatus('이미 선택한 화자로 표시되어 있습니다.');
        return;
      }
      setLast(change);
      setSelected(new Map());
      setOnlySelected(false);
      setName('');
      setStatus(`${change.previous.length}개 발언의 화자를 변경했습니다.${record.summary ? ' 필요한 경우 요약을 다시 만들어 화자 변경을 반영하세요.' : ''}`);
    });
  }

  function undo() {
    if (!last) return;
    void perform(async () => {
      await save(latest => undoMeetingSpeakerCorrection(latest,last));
      setLast(undefined);
      setStatus('마지막 화자 변경을 되돌렸습니다.');
    });
  }

  function suggest() {
    if (!reference || !findSimilar) return;
    void perform(async () => {
      const similar = new Set(await findSimilar(reference));
      const candidates = turns.filter(turn => turn.id !== reference.id && similar.has(turn.id));
      setSelected(previous => new Map([...previous,...candidates.map(turn => [turn.id,turn.speakerId] as const)]));
      if (candidates.length) setOnlySelected(true);
      setStatus(candidates.length ?
        `비슷한 발언 ${candidates.length}개를 선택했습니다. 확인한 뒤 옮겨 주세요.` :
        '같은 목소리로 보이는 다른 발언을 찾지 못했습니다.');
    });
  }

  return <details className="edit-record speaker-correction" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>화자 정정 (선택 사항)</summary>
    {expanded && <form aria-label="화자 정정" onSubmit={submit}>
      <p className="muted">잘못 배정된 발언을 골라 기존 화자나 새 화자로 옮길 수 있습니다.</p>
      {onlySelected && <div>
        <button className="button quiet" type="button" onClick={() => setOnlySelected(false)} disabled={disabled}>모든 발언 보기</button>
      </div>}
      <div className="speaker-correction-list" role="region" aria-label="화자를 바꿀 발언" tabIndex={0}>
        {(onlySelected ? turns.filter(turn=>selected.has(turn.id)) : turns).map(turn => <div className="speaker-correction-row" key={turn.id}>
          <label className="checkbox">
            <input type="checkbox" checked={selected.has(turn.id)} onChange={event=>toggle(turn,event.currentTarget.checked)} disabled={disabled} />
            <span>
              <small className="muted">{timeLabel(turn.timeMs)} · {speakerLabel(record,turn)}</small>
              {transcriptText(turn)}
            </span>
          </label>
          {playAt?.(turn)}
        </div>)}
        {onlySelected && !selected.size && <p className="muted">선택한 발언이 없습니다.</p>}
      </div>
      {findSimilar ? <div>
        <button className="button quiet" type="button" onClick={suggest} disabled={disabled || !reference}>
          기준 발언과 비슷한 발언 찾기
        </button>
        <p className="muted">실제 화자가 확실한 발언 하나만 선택해 주세요.</p>
      </div> : audioAvailable ? <SpeakerModelSetup /> : <p className="muted">비슷한 발언을 비교하려면 회의 시작 전에 원본 음성 보관을 선택하세요.</p>}
      <label>옮길 화자
        <select value={targetSelected ? target : ''} onChange={event=>setTarget(event.currentTarget.value)} disabled={disabled} required>
          <option value="">화자 선택</option>
          {groups.map(group => <option value={groupPrefix+group.id} key={group.id}>
            {group.name ? `${group.name} · ${group.label}` : group.label}
          </option>)}
          <option value={newTarget}>새 화자 추가</option>
        </select>
      </label>
      {target === newTarget && <label>새 화자 이름 (선택 사항)
        <input value={name} onChange={event=>setName(event.currentTarget.value)} maxLength={100} disabled={disabled} />
      </label>}
      <div className="actions">
        <button type="submit" className="button primary" disabled={disabled || !targetSelected || !selected.size}>
          {selected.size ? `선택한 ${selected.size}개 발언 옮기기` : '선택한 발언 옮기기'}
        </button>
        {last && <button type="button" className="button quiet" disabled={disabled} onClick={undo}>마지막 변경 되돌리기</button>}
      </div>
      {status && <p className="muted" role="status">{status}</p>}
      {error && <p className="muted" role="alert">{error}</p>}
    </form>}
  </details>;
}
