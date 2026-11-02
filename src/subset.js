// 글꼴 부분 추출 (HarfBuzz hb-subset, WebAssembly)
// pdf-lib 자체의 부분 추출(subset: true)은 나눔 글꼴에서 글자가 깨지는 문제가 있어,
// 쓰인 글자만 남긴 작은 글꼴을 먼저 만든 뒤 pdf-lib에는 통째로(subset: false) 넣음
let wasmPromise = null;

/** @param {() => Promise<ArrayBuffer|Uint8Array>} loadWasm */
function getWasm(loadWasm) {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const bytes = await loadWasm();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports;
    })();
  }
  return wasmPromise;
}

/**
 * @param {Uint8Array} fontBytes
 * @param {string} text  남길 글자들
 * @param {() => Promise<ArrayBuffer|Uint8Array>} loadWasm
 * @returns {Promise<Uint8Array>}
 */
export async function subsetFont(fontBytes, text, loadWasm) {
  const ex = await getWasm(loadWasm);
  const heap = () => new Uint8Array(ex.memory.buffer);
  const ptr = ex.malloc(fontBytes.byteLength);
  heap().set(fontBytes, ptr);
  const blob = ex.hb_blob_create(ptr, fontBytes.byteLength, 2 /* HB_MEMORY_MODE_WRITABLE */, 0, 0);
  const face = ex.hb_face_create(blob, 0);
  ex.hb_blob_destroy(blob);
  const input = ex.hb_subset_input_create_or_fail();
  if (!input) throw new Error('글꼴 처리 준비 실패');
  const uni = ex.hb_subset_input_unicode_set(input);
  const cps = new Set([0x20, 0x3f]); // 공백·물음표는 늘 포함
  for (const ch of text) cps.add(ch.codePointAt(0));
  for (const cp of cps) ex.hb_set_add(uni, cp);
  const sub = ex.hb_subset_or_fail(face, input);
  ex.hb_subset_input_destroy(input);
  if (!sub) {
    ex.hb_face_destroy(face);
    ex.free(ptr);
    throw new Error('글꼴 부분 추출 실패');
  }
  const outBlob = ex.hb_face_reference_blob(sub);
  const off = ex.hb_blob_get_data(outBlob, 0);
  const len = ex.hb_blob_get_length(outBlob);
  const out = heap().slice(off, off + len);
  ex.hb_blob_destroy(outBlob);
  ex.hb_face_destroy(sub);
  ex.hb_face_destroy(face);
  ex.free(ptr);
  if (!len) throw new Error('글꼴 부분 추출 결과가 비어 있음');
  // 마지막 글리프(공백 등 빈 글리프)를 fontkit이 읽을 때 파일 끝을 넘지 않도록 0으로 덧붙임
  const padded = new Uint8Array(len + 32);
  padded.set(out);
  return padded;
}
