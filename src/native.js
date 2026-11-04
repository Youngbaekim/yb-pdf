// 데스크톱 앱(Windows 설치판)에서만 쓰는 파일 기능
// - 웹판의 '파일 핸들'(FileSystemFileHandle)과 같은 모양의 대체물을 만들어, 나머지 코드는 그대로 동작하게 함
// - 웹(브라우저)에서는 native = null
export const native = window.ybpdfNative || null;

const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));

/** 경로 → 파일 핸들 대체물 */
export function pathHandle(path, name = baseName(path)) {
  return {
    kind: 'file',
    name,
    __path: path,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFile: async () => {
      const r = await native.read(path);
      return new File([r.bytes], name, { type: 'application/pdf' });
    },
    createWritable: async () => {
      const parts = [];
      return {
        write: async (d) => { parts.push(d); },
        close: async () => { await native.write(path, new Uint8Array(await new Blob(parts).arrayBuffer())); },
      };
    },
    isSameEntry: async (o) => !!o?.__path && o.__path.toLowerCase() === path.toLowerCase(),
  };
}

/** 저장소(IndexedDB)에 넣을 수 있는 모양으로 (함수는 저장되지 않으므로 경로만) */
export const storable = (h) => (h?.__path ? { __path: h.__path, name: h.name } : h);
/** 저장소에서 꺼낸 것을 다시 핸들로 */
export const revive = (h) => (h?.__path && typeof h.getFile !== 'function' ? pathHandle(h.__path, h.name) : h);

export async function nativeOpenDialog() {
  const paths = await native.openDialog();
  return paths.map((p) => pathHandle(p));
}
export async function nativeSaveDialog(name, nearHandle) {
  const p = await native.saveDialog(name, nearHandle?.__path ? dirName(nearHandle.__path) : undefined);
  return p ? pathHandle(p) : null;
}
