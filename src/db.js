// 기기 안 저장소 (IndexedDB)
// - recent : 최근 파일(파일 위치 핸들)
// - handoff: 탭을 다른 창으로 옮길 때 잠시 맡겨 두는 문서 (받는 창이 꺼내면 바로 지움)
import { openDB } from 'idb';

export const dbp = openDB('ybpdf', 2, {
  upgrade(db, old) {
    if (old < 1) db.createObjectStore('recent', { keyPath: 'name' });
    if (old < 2) db.createObjectStore('handoff');
  },
}).catch(() => null);
