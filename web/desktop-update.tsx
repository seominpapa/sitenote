import React, { useEffect, useState } from 'react';

type Check = {status: 'current'; currentVersion: string}
  | {status: 'available' | 'downloaded'; currentVersion: string; version: string; assetName: string; size: number};
type DesktopBridge = {
  version: () => Promise<string>;
  check: () => Promise<Check>;
  download: () => Promise<Check>;
  open: () => Promise<boolean>;
};

declare global {
  interface Window { sitenoteDesktop?: DesktopBridge }
}

export function DesktopUpdate({settings, visible, busy}: {settings: boolean; visible: boolean; busy: boolean}) {
  const desktop = window.sitenoteDesktop;
  const [version, setVersion] = useState('');
  const [result, setResult] = useState<Check>();
  const [working, setWorking] = useState(false);
  const [later, setLater] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void desktop.version().then(value => { if (alive) setVersion(value); }, () => {});
    setWorking(true);
    void desktop.check().then(value => { if (alive) setResult(value); }, () => {})
      .finally(() => { if (alive) setWorking(false); });
    return () => { alive = false; };
  }, [desktop]);

  async function run(action: () => Promise<void>, failure: string) {
    setWorking(true);
    setLater(false);
    setMessage('');
    try { await action(); } catch { setMessage(failure); }
    finally { setWorking(false); }
  }

  if (!desktop || !visible || (!settings && (later || !result || result.status === 'current'))) return null;
  const download = result?.status !== 'current' ? result : undefined;
  const mac = download?.assetName.endsWith('.dmg');
  return <section className="summary" aria-labelledby="desktop-update">
    <h2 id="desktop-update">{settings ? '앱 업데이트' : '새 버전이 있습니다. 업데이트할까요?'}</h2>
    <div aria-live="polite">
      {version && <p className="muted">현재 버전 {version}</p>}
      {download && <p><strong>새 버전 {download.version}</strong> · {Math.ceil(download.size / (1024 * 1024))} MB</p>}
      {working && <p>업데이트 확인 또는 다운로드 중…</p>}
      {settings && result?.status === 'current' && !message && !working && <p>최신 버전을 사용 중입니다.</p>}
      {download?.status === 'downloaded' && <p>다운로드와 파일 검증을 마쳤습니다. {mac
        ? '디스크 이미지를 열고, 이 앱을 종료한 다음 새 앱을 응용 프로그램 폴더에 복사하세요.'
        : '파일 위치를 열고, 이 앱을 종료한 다음 새 EXE를 원하는 폴더로 옮겨 실행하세요.'}</p>}
      {message && <p>{message}</p>}
    </div>
    <div className="actions">
      {settings && <button className="button quiet" disabled={busy || working}
        onClick={() => void run(async () => { setResult(undefined); setResult(await desktop.check()); }, '업데이트를 확인하지 못했습니다. 인터넷에 연결한 뒤 다시 시도하세요.')}>업데이트 확인</button>}
      {download?.status === 'available' && <button className="button primary" disabled={busy || working}
        onClick={() => void run(async () => setResult(await desktop.download()), '업데이트 파일을 받거나 검증하지 못했습니다. 다시 시도하세요.')}>업데이트 다운로드</button>}
      {download?.status === 'downloaded' && <button className="button primary" disabled={busy || working}
        onClick={() => void run(async () => {
          try { await desktop.open(); }
          catch (error) { setResult({...download, status:'available'}); throw error; }
        }, '검증한 파일을 열지 못했습니다. 다시 다운로드해 주세요.')}>{mac ? 'DMG 열기' : 'EXE 파일 위치 열기'}</button>}
      {!settings && <button className="button quiet" disabled={working} onClick={() => setLater(true)}>나중에</button>}
    </div>
  </section>;
}
