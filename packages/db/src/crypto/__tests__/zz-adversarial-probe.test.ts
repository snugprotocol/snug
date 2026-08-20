import { describe, expect, it } from 'vitest';
import {
  encryptContainer, decryptContainer, generateRecoveryKey, rewrapPassphrase,
  resealContainer, openFileKey, isEncryptedContainer,
} from '../container.js';

const PASS='pw-correct-horse';
const enc = async (plain=new Uint8Array([1,2,3,4,5,6,7,8])) =>
  ({bytes: await encryptContainer(plain, {passphrase:PASS, recoveryKey: generateRecoveryKey()}), plain});

describe('probe', () => {
  it('A: layout sanity', async () => {
    const {bytes}=await enc();
    console.log('total len', bytes.length);
    const HEADER_FIXED=38, SLOT_LEN=61, WRAPPED=48, IV=12;
    console.log('expected', HEADER_FIXED+2*SLOT_LEN+2*WRAPPED+IV+(8+16));
    console.log('slotCount', new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(32));
  });

  it('B: parse over a Uint8Array VIEW with nonzero byteOffset', async () => {
    const {bytes,plain}=await enc();
    const big=new Uint8Array(bytes.length+64);
    big.set(bytes, 33);                  // offset view
    const view=big.subarray(33, 33+bytes.length);
    expect(view.byteOffset).toBe(33);
    const r=await decryptContainer(view, {passphrase:PASS});
    console.log('offset-view decrypt =>', r.status, 'reason' in r ? r.reason : '');
    expect(r.status).toBe('ok');
  });

  it('C: checksumOver on an offset-backed header', async () => {
    // parse() does header = bytes.slice(...) so header.byteOffset===0. checksumOver does
    // Uint8Array.from(header) -> fresh buffer. Confirm both consistent.
    const {bytes}=await enc();
    const r=await decryptContainer(bytes,{passphrase:PASS});
    expect(r.status).toBe('ok');
  });

  it('D: slotCount inflation misparse', async () => {
    const {bytes}=await enc();
    const t=Uint8Array.from(bytes);
    const dv=new DataView(t.buffer);
    dv.setUint16(32, 8);                 // claim 8 slots (max allowed)
    // recompute checksum so parse() passes structural check
    const HEADER_FIXED=38, SLOT_LEN=61;
    const headerLen=HEADER_FIXED+8*SLOT_LEN;
    console.log('inflated headerLen', headerLen, 'file len', t.length);
    const r=await decryptContainer(t,{passphrase:PASS});
    console.log('slotCount=8 =>', r.status, 'reason' in r ? r.reason : '');
  });

  it('E: rewrap then decrypt with recovery key still works', async () => {
    const rk=generateRecoveryKey();
    const c=await encryptContainer(new Uint8Array([9,9,9]), {passphrase:PASS, recoveryKey:rk});
    const rw=await rewrapPassphrase(c,{current:PASS,next:'new-pass'});
    expect(rw.status).toBe('ok');
    if(rw.status!=='ok')return;
    console.log('len same?', rw.bytes.length===c.length);
    const byNew=await decryptContainer(rw.bytes,{passphrase:'new-pass'});
    const byOld=await decryptContainer(rw.bytes,{passphrase:PASS});
    const byRk =await decryptContainer(rw.bytes,{recoveryKey:rk});
    console.log('new',byNew.status,'old',byOld.status,'rk',byRk.status);
    expect(byNew.status).toBe('ok'); expect(byOld.status).toBe('locked'); expect(byRk.status).toBe('ok');
  });

  it('F: IV freshness across reseal', async () => {
    const {bytes}=await enc();
    const k=await openFileKey(bytes,{passphrase:PASS});
    if(k.status!=='ok')throw new Error('no key');
    const ivs=new Set<string>();
    let cur=bytes;
    for(let i=0;i<50;i++){
      cur=await resealContainer(bytes,k.fileKey,new Uint8Array([i]));
      const headAndSlots=38+2*61+2*48;
      ivs.add(Array.from(cur.slice(headAndSlots,headAndSlots+12)).join(','));
    }
    console.log('distinct IVs over 50 reseals:', ivs.size);
    expect(ivs.size).toBe(50);
  });

  it('G: reseal preserves both slots and total structure', async () => {
    const rk=generateRecoveryKey();
    const c=await encryptContainer(new Uint8Array([7]), {passphrase:PASS, recoveryKey:rk});
    const k=await openFileKey(c,{passphrase:PASS});
    if(k.status!=='ok')throw new Error('x');
    const r=await resealContainer(c,k.fileKey,new Uint8Array([1,2,3]));
    console.log('rk opens resealed:', (await decryptContainer(r,{recoveryKey:rk})).status);
    console.log('pass opens resealed:', (await decryptContainer(r,{passphrase:PASS})).status);
  });

  it('H: truncation / garbage fuzz — no crash, no hang', async () => {
    const {bytes}=await enc();
    for(let n=0;n<bytes.length;n+=7){
      const r=await decryptContainer(bytes.slice(0,n),{passphrase:PASS});
      if(r.status==='ok') console.log('!!! truncated to',n,'still OK');
    }
    // random garbage after magic
    for(let t=0;t<200;t++){
      const g=Uint8Array.from(bytes);
      for(let i=0;i<20;i++) g[9+Math.floor(Math.random()*(g.length-9))]=Math.floor(Math.random()*256);
      const r=await decryptContainer(g,{passphrase:PASS});
      expect(['locked','corrupt','ok']).toContain(r.status);
    }
    console.log('fuzz done');
  });

  it('I: huge slotCount allocation', async () => {
    const {bytes}=await enc();
    const t=Uint8Array.from(bytes);
    new DataView(t.buffer).setUint16(32, 0xffff);
    const r=await decryptContainer(t,{passphrase:PASS});
    console.log('slotCount 65535 =>', r.status, 'reason' in r?r.reason:'');
  });

  it('J: empty-string passphrase and slot-skip', async () => {
    const {bytes}=await enc();
    console.log('no secrets =>',(await decryptContainer(bytes,{})).status);
    console.log('empty pass =>',(await decryptContainer(bytes,{passphrase:''})).status);
  });
});
