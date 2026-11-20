import React, { type ReactNode } from 'react';

export type Jump = (id: string, part?: string) => void;
type Name = 'wave' | 'mic' | 'speaker' | 'people' | 'arrow' | 'file' | 'folder' | 'download' | 'search' | 'settings';
const paths: Record<Name, ReactNode> = {
  wave: <path d="M3 12h3l2.5-6 3 12 3.5-12 2 6h4" />,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6" /></>,
  speaker: <path d="M3 9v6h4l5 4V5L7 9zm12 0a4 4 0 0 1 0 6m3-8a7 7 0 0 1 0 10" />,
  people: <><path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m3-6a4 4 0 0 1 3 4v2m-3-15a3.5 3.5 0 0 1 0 7" /><circle cx="9" cy="8" r="3.5" /></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  file: <><path d="M6 3h9l3 3v15H6zM9 12h6m-6 4h6" /><path d="M14 3v4h4" /></>,
  folder: <path d="M3 6h7l2 2h9v11H3z" />,
  download: <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  settings: <path d="M4 7h6m4 0h6M4 17h10m4 0h2M10 4v6m4 4v6" />,
};
export function Icon({ name }: { name: Name }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export const date = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
