// 선 아이콘 (24×24, currentColor)
const s = (d, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const ICONS = {
  open: s('<path d="M3 7.5V18a2 2 0 0 0 2 2h13.2a2 2 0 0 0 1.9-1.4L22 12H8.2a2 2 0 0 0-1.9 1.4L4 20"/><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v4"/>'),
  save: s('<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2Z"/><path d="M8 3v5h7V3"/><rect x="7" y="13" width="10" height="7" rx="1"/>'),
  select: s('<path d="M5 3.5 18.5 10l-6 1.6-2.4 5.9Z"/><path d="m12.6 11.7 5.4 5.4"/>'),
  hand: s('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v7"/><path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.5a6 6 0 0 1-4.6-2.2L4 15.2a1.6 1.6 0 0 1 2.4-2.1L8 14.5"/>'),
  highlight: s('<path d="m9 15-4 4h5l2-2"/><path d="m8.5 14.5 7.8-9.8a2 2 0 0 1 2.8-.3l.5.4a2 2 0 0 1 .3 2.8l-7.8 9.9Z"/><path d="M3 21.5h18" stroke="#f5c400" stroke-width="2.6"/>'),
  pen: s('<path d="M15.2 4.8a2.4 2.4 0 0 1 3.4 3.4L8 18.8 3.5 20.5 5.2 16Z"/><path d="m13.5 6.5 4 4"/>'),
  note: s('<path d="M5 3h14a2 2 0 0 1 2 2v9l-7 7H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/><path d="M7 8h10M7 12h6"/>'),
  text: s('<rect x="3" y="3" width="18" height="18" rx="2.5" stroke-dasharray="3 2.4"/><path d="M8 8h8M12 8v9"/>'),
  replace: s('<path d="M3 6h9M7.5 6v10"/><path d="M2.5 11h10" stroke-width="1.4" opacity=".55"/><path d="M15.5 20.5 14 21l.5-1.5 6-6a1.1 1.1 0 0 1 1.5 1.5Z"/>'),
  sign: s('<path d="M3 17c2.5-6 4-9 5.5-9S8 14 9.5 14 12 9 13.5 9s.5 5 2 5 2-2 3-2"/><path d="M3 21h18"/>'),
  eraser: s('<path d="m7 21-4.3-4.3a1.5 1.5 0 0 1 0-2.1l9.9-9.9a1.5 1.5 0 0 1 2.1 0l5.6 5.6a1.5 1.5 0 0 1 0 2.1L12 21"/><path d="M7 21h14"/><path d="m5.5 12.5 6 6"/>'),
  undo: s('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: s('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  spread1: s('<rect x="6.5" y="3" width="11" height="18" rx="1.6"/>'),
  spread2: s('<rect x="2.5" y="4" width="9" height="16" rx="1.4"/><rect x="12.5" y="4" width="9" height="16" rx="1.4"/>'),
  panel: s('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/><path d="m10 10-2 2 2 2"/>'),
  panelClose: s('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/><path d="m8 10 2 2-2 2"/>'),
  up: s('<path d="m6 15 6-6 6 6"/>'),
  down: s('<path d="m6 9 6 6 6-6"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  minus: s('<path d="M5 12h14"/>'),
};

export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon] || ''; });
}
