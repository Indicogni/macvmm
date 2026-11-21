// Tests for the linker-map model (node --test).
//
// LLD_VECTORS below are real outputs, not hand-written expectations. They were produced on the
// reference Mac (rustc 1.99, rust-lld) from the bare-metal-rust primer's program, compiled once
// with `cargo rustc --release -- --emit=obj` (and once more with the primer's `WHERE` static),
// then linked with the primer's linker script in 19 layouts by
//   rust-lld -flavor gnu --fix-cortex-a53-843419 bare.o -z noexecstack --eh-frame-hdr \
//            --gc-sections -O1 --strip-debug -T <variant>.ld -o <variant>.elf
// (the arguments `cargo build` passes) and read back with llvm-nm -n, llvm-readobj
// --program-headers and llvm-objcopy -O binary. `order` uses t r d b for .text .rodata .data
// .bss and f<addr> for the primer's `.far <addr> : { BYTE(1) }` section.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  initialState, step, link, rawLoad, hexRows, flatByte, encodeHash, decodeHash, parseHex,
  disasm, scriptText, summary, hex, PRESETS, erratumSites, moveText,
} from "./model.mjs";

const LLD_VECTORS = [
  {"name":"base","where":false,"start":"0x40080000","order":"t,r,d,b","stack":"0x4000","syms":[["40080000","T","_start"],["40080038","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080040","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40084060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",6,6,"R"],["0x10040","0x40080040",4,16416,"RW"]],"binSize":68,"binSha256":"c2aa11c14f0970793981a08f5724310842886466b4d36f3c7bac0738aa2c5e8d","binHex":"ff4300d11f2003d588010010e80700f9e823009108000090094140b929050011094100b908000090095140b929050011095100b9fdffff1768656c6c6f0a000007000000"},
  {"name":"rfirst","where":false,"start":"0x40080000","order":"r,t,d,b","stack":"0x4000","syms":[["40080000","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080008","T","_start"],["40080040","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40084060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",6,6,"R"],["0x10008","0x40080008",56,56,"RX"],["0x10040","0x40080040",4,16416,"RW"]],"binSize":68,"binSha256":"ba2bd52b94c2f2ed46e2c024b875374434cb4edf0bea6a8b01c409727c06a8ef","binHex":"68656c6c6f0a0000ff4300d11f2003d588ffff10e80700f9e823009108000090094140b929050011094100b908000090095140b929050011095100b9fdffff1707000000"},
  {"name":"bssmid","where":false,"start":"0x40080000","order":"t,r,b,d","stack":"0x4000","syms":[["40080000","T","_start"],["40080038","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080040","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080040","B","__bss_start"],["40080050","B","__bss_end"],["40084050","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40084050","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",6,6,"R"],["0x10040","0x40080040",16404,16404,"RW"]],"binSize":16468,"binSha256":"89d9d929edae68b4224314088f967c249b910c9316e3d6b7ac62f52cbd3a570e"},
  {"name":"dfirst","where":false,"start":"0x40080000","order":"t,d,r,b","stack":"0x4000","syms":[["40080000","T","_start"],["40080038","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["4008003c","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40084060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",4,4,"RW"],["0x1003c","0x4008003c",6,6,"R"],["0x10050","0x40080050",0,16400,"RW"]],"binSize":66,"binSha256":"387291cfcd8319650eba1d0769253d60d59c8fab67988755574444db339850f7","binHex":"ff4300d11f2003d5a8010010e80700f9e823009108000090093940b929050011093900b908000090095140b929050011095100b9fdffff170700000068656c6c6f0a"},
  {"name":"bfirst","where":false,"start":"0x40080000","order":"b,t,r,d","stack":"0x4000","syms":[["40080000","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080000","B","__bss_start"],["40080010","B","__bss_end"],["40084010","B","__stack_top"],["40084010","T","_start"],["40084048","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40084050","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"]],"phdrs":[["0x10000","0x40080000",0,16400,"RW"],["0x14010","0x40084010",56,56,"RX"],["0x14048","0x40084048",6,6,"R"],["0x14050","0x40084050",4,4,"RW"]],"binSize":68,"binSha256":"5a80690b2e9fd8b7ae7dd2a771f248070aa944f1d8c5de33c003933d8f011afd","binHex":"ff4300d11f2003d588010010e80700f9e823009108000090095140b929050011095100b9e8ffff90090140b929050011090100b9fdffff1768656c6c6f0a000007000000"},
  {"name":"drtb","where":false,"start":"0x40080000","order":"d,r,t,b","stack":"0x4000","syms":[["40080000","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40080004","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["4008000c","T","_start"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40084060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",4,4,"RW"],["0x10004","0x40080004",6,6,"R"],["0x1000c","0x4008000c",56,56,"RX"],["0x10050","0x40080050",0,16400,"RW"]],"binSize":68,"binSha256":"d2e34309a3e0cc76021c0a5b872cfffdc23fb3e0bd0b42d3b433108e07a673f1","binHex":"0700000068656c6c6f0a0000ff4300d11f2003d588ffff10e80700f9e823009108000090090140b929050011090100b908000090095140b929050011095100b9fdffff17"},
  {"name":"start","where":false,"start":"0x40100000","order":"t,r,d,b","stack":"0x4000","syms":[["40100000","T","_start"],["40100038","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40100040","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40100050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40100050","B","__bss_start"],["40100060","B","__bss_end"],["40104060","B","__stack_top"]],"phdrs":[["0x10000","0x40100000",56,56,"RX"],["0x10038","0x40100038",6,6,"R"],["0x10040","0x40100040",4,16416,"RW"]],"binSize":68,"binSha256":"c2aa11c14f0970793981a08f5724310842886466b4d36f3c7bac0738aa2c5e8d","binHex":"ff4300d11f2003d588010010e80700f9e823009108000090094140b929050011094100b908000090095140b929050011095100b9fdffff1768656c6c6f0a000007000000"},
  {"name":"stack64k","where":false,"start":"0x40080000","order":"t,r,d,b","stack":"0x10000","syms":[["40080000","T","_start"],["40080038","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080040","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40090060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",6,6,"R"],["0x10040","0x40080040",4,65568,"RW"]],"binSize":68,"binSha256":"c2aa11c14f0970793981a08f5724310842886466b4d36f3c7bac0738aa2c5e8d","binHex":"ff4300d11f2003d588010010e80700f9e823009108000090094140b929050011094100b908000090095140b929050011095100b9fdffff1768656c6c6f0a000007000000"},
  {"name":"far","where":false,"start":"0x40080000","order":"t,r,d,f0x40180000,b","stack":"0x4000","syms":[["40080000","T","_start"],["40080038","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080040","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40180010","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40180010","B","__bss_start"],["40180020","B","__bss_end"],["40184020","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",6,6,"R"],["0x10040","0x40080040",1048513,1064928,"RW"]],"binSize":1048577,"binSha256":"5c9888fabfbe58257cd4f52362e0d036c204e1b952b2edffd02e61c85cd23f5a"},
  {"name":"farmid","where":false,"start":"0x40080000","order":"t,f0x40180000,r,d,b","stack":"0x4000","syms":[["40080000","T","_start"],["40180001","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40180008","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40180010","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40180010","B","__bss_start"],["40180020","B","__bss_end"],["40184020","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x20000","0x40180000",7,7,"R"],["0x20008","0x40180008",4,16408,"RW"]],"binSize":1048588,"binSha256":"0de8d62b8a52ae00ca605bdee989d619776df0de1e087c8c70d47ba448211314"},
  {"name":"farmid2","where":false,"start":"0x40080000","order":"t,f0x40280000,r,d,b","stack":"0x4000","syms":[["40080000","T","_start"],["40280001","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40280008","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40280010","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40280010","B","__bss_start"],["40280020","B","__bss_end"],["40284020","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x20000","0x40280000",7,7,"R"],["0x20008","0x40280008",4,16408,"RW"]],"binSize":2097164,"binSha256":"898cc125d37e8672ca9b07a3d223118b9a0e1886dc83e7b3aac705948ccf2b17"},
  {"name":"farfirst","where":false,"start":"0x40080000","order":"f0x40070000,t,r,d,b","stack":"0x4000","syms":[["40070004","T","_start"],["4007003c","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40070044","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40070050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40070050","B","__bss_start"],["40070060","B","__bss_end"],["40074060","B","__stack_top"]],"phdrs":[["0x10000","0x40070000",1,1,"R"],["0x10004","0x40070004",56,56,"RX"],["0x1003c","0x4007003c",6,6,"R"],["0x10044","0x40070044",4,16412,"RW"]],"binSize":72,"binSha256":"da98cb17bc62eb4ea3eaec131f036828b0ac466401663f4ea3f81a673fccd6e2","binHex":"01000000ff4300d11f2003d588010010e80700f9e823009108000090094540b929050011094500b908000090095140b929050011095100b9fdffff1768656c6c6f0a000007000000"},
  {"name":"farafterr","where":false,"start":"0x40080000","order":"t,r,f0x40180000,d,b","stack":"0x4000","syms":[["40080000","T","_start"],["40080038","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40180004","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40180010","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40180010","B","__bss_start"],["40180020","B","__bss_end"],["40184020","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",1048521,1048521,"R"],["0x110004","0x40180004",4,16412,"RW"]],"binSize":1048584,"binSha256":"ef72b8e19d07e10c4b05b5f0250c4883f419a22b6bb28cf0d3289d37137d4fd2"},
  {"name":"where","where":true,"start":"0x40080000","order":"t,r,d,b","stack":"0x4000","syms":[["40080000","T","_start"],["40080038","r","_RNvCs2IAovmNIQZv_4bare5WHERE"],["40080040","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080048","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40084060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",14,14,"R"],["0x10048","0x40080048",4,16408,"RW"]],"binSize":76,"binSha256":"27e8619cf8a606029cd12cf342a3eba11e5519f7b29bd1ae897fa52fa268dabf","binHex":"ff4300d11f2003d588010010e80700f9e823009108000090094940b929050011094900b908000090095140b929050011095100b9fdffff17400008400000000068656c6c6f0a000007000000"},
  {"name":"where_rfirst","where":true,"start":"0x40080000","order":"r,t,d,b","stack":"0x4000","syms":[["40080000","r","_RNvCs2IAovmNIQZv_4bare5WHERE"],["40080008","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080010","T","_start"],["40080048","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40084060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",14,14,"R"],["0x10010","0x40080010",56,56,"RX"],["0x10048","0x40080048",4,16408,"RW"]],"binSize":76,"binSha256":"b48d517ba25774dc92064738d2d853f12b306f2fb1be4de8965aeddac8104b51","binHex":"080008400000000068656c6c6f0a0000ff4300d11f2003d548ffff10e80700f9e823009108000090094940b929050011094900b908000090095140b929050011095100b9fdffff1707000000"},
  {"name":"where_bssmid","where":true,"start":"0x40080000","order":"t,r,b,d","stack":"0x4000","syms":[["40080000","T","_start"],["40080038","r","_RNvCs2IAovmNIQZv_4bare5WHERE"],["40080040","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["40080050","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080050","B","__bss_start"],["40080060","B","__bss_end"],["40084060","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40084060","B","__stack_top"]],"phdrs":[["0x10000","0x40080000",56,56,"RX"],["0x10038","0x40080038",14,14,"R"],["0x10050","0x40080050",16404,16404,"RW"]],"binSize":16484,"binSha256":"6642c5a3bd07354c3ec203d7f2cfebee905e18708a74915b18e543c132fcb3a5"},
  {"name":"bdtr","where":false,"start":"0x40080000","order":"b,d,t,r","stack":"0x4000","syms":[["40080000","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080000","B","__bss_start"],["40080010","B","__bss_end"],["40084010","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40084010","B","__stack_top"],["40084014","T","_start"],["4008404c","r","_RNvCs2IAovmNIQZv_4bare8GREETING"]],"phdrs":[["0x10000","0x40080000",16404,16404,"RW"],["0x14014","0x40084014",56,56,"RX"],["0x1404c","0x4008404c",6,6,"R"]],"binSize":66,"binSha256":"aa7b17ceab64848ff311d3e3b804634ad1456201db9999215cd4793a28f7c3e5","binHex":"07000000ff4300d11f2003d588010010e80700f9e823009108000090091140b929050011091100b9e8ffff90090140b929050011090100b9fdffff1768656c6c6f0a"},
  {"name":"far0","where":false,"start":"0x40080000","order":"f0x0,t,r,d,b","stack":"0x4000","syms":[["4","T","_start"],["3c","r","_RNvCs2IAovmNIQZv_4bare8GREETING"],["44","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["50","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["50","B","__bss_start"],["60","B","__bss_end"],["4060","B","__stack_top"]],"phdrs":[["0x10000","0x0",1,1,"R"],["0x10004","0x4",56,56,"RX"],["0x1003c","0x3c",6,6,"R"],["0x10044","0x44",4,16412,"RW"]],"binSize":72,"binSha256":"da98cb17bc62eb4ea3eaec131f036828b0ac466401663f4ea3f81a673fccd6e2","binHex":"01000000ff4300d11f2003d588010010e80700f9e823009108000090094540b929050011094500b908000090095140b929050011095100b9fdffff1768656c6c6f0a000007000000"},
  {"name":"erratum","where":false,"start":"0x40080000","order":"b,d,t,r","stack":"0xfd0","syms":[["40080000","b","_RNvCs2IAovmNIQZv_4bare7COUNTER.0"],["40080000","B","__bss_start"],["40080010","B","__bss_end"],["40080fe0","d","_RNvCs2IAovmNIQZv_4bare5BOOTS.0"],["40080fe0","B","__stack_top"],["40080fe4","T","_start"],["4008101c","t","__CortexA53843419_40081004"],["40081024","r","_RNvCs2IAovmNIQZv_4bare8GREETING"]],"phdrs":[["0x10000","0x40080000",4068,4068,"RW"],["0x10fe4","0x40080fe4",64,64,"RX"],["0x11024","0x40081024",6,6,"R"]],"binSize":74,"binSha256":"97ca2e016915854ae26e49c1ca8e6d129d6ae8abbc036c197a5d16aa98fd1f92","binHex":"07000000ff4300d11f2003d5c8010010e80700f9e82300910800009009e14fb92905001106000014e8fffff0090140b929050011090100b9fdffff1709e10fb9faffff1768656c6c6f0a"},
];

const CODE = { t: "text", r: "rodata", d: "data", b: "bss" };

function stateFor(v) {
  let s = initialState("bare");
  if (v.where) s = step(s, { type: "where", on: true });
  const order = [];
  for (const tok of v.order.split(",")) {
    if (tok.startsWith("f")) {
      s = step(s, { type: "far", on: true });
      s = step(s, { type: "farAddr", text: tok.slice(1) });
      order.push("far");
    } else order.push(CODE[tok]);
  }
  s = { ...s, order };
  s = step(s, { type: "start", text: v.start });
  s = step(s, { type: "stack", text: v.stack });
  assert.deepEqual(s.errors, {}, `${v.name}: inputs accepted`);
  return s;
}

function flatToBuffer(flat) {
  const buf = Buffer.alloc(Number(flat.size));
  for (const c of flat.chunks) if (c.bytes) Buffer.from(c.bytes).copy(buf, Number(c.off));
  return buf;
}

for (const v of LLD_VECTORS) {
  test(`matches rust-lld: ${v.name}`, () => {
    const res = link(stateFor(v));
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(
      res.symbols.map((s) => [s.addr.toString(16), s.letter, s.key]),
      v.syms,
      "llvm-nm -n",
    );
    assert.deepEqual(
      res.phdrs.map((p) => ["0x" + p.offset.toString(16), "0x" + p.vaddr.toString(16), Number(p.filesz), Number(p.memsz), p.flags]),
      v.phdrs,
      "program headers",
    );
    assert.equal(Number(res.flat.size), v.binSize, "flat binary size");
    const buf = flatToBuffer(res.flat);
    if (v.binHex) assert.equal(buf.toString("hex"), v.binHex, "flat binary bytes");
    assert.equal(createHash("sha256").update(buf).digest("hex"), v.binSha256, "flat binary sha256");
  });
}

// Chapter 03's hello guest with COUNTER, rebuilt on the reference Mac from the change the capture
// describes (it reproduces captures/03-bss-nm.txt exactly), then relinked with
// guests/common/link.ld's sections reordered (.data stays in each script; it is empty and rust-lld
// drops it). Read back with llvm-nm -n (only the symbols the lab models), llvm-readobj
// --program-headers and `wc -c` of llvm-objcopy -O binary.
const GUEST_VECTORS = [
  {"name":"guest default","order":"t,r,b","syms":[["40080000","T","__image_start"],["40080000","T","_start"],["40080078","T","_secondary_start"],["40080800","T","guest_vectors"],["40082e60","b","_RNvCsieMabytS3dp_5hello7COUNTER.0"],["40082e60","B","__bss_start"],["40082e80","b","_RNvNtCsd92i63ulmgm_5guest7console7BACKEND.0"],["40082e90","B","__stacks_start"],["40102e90","B","__bss_end"],["40102e90","B","__image_end"],["40102e90","B","__stacks_end"]],"phdrs":[["0x10000","0x40080000",10976,10976,"RX"],["0x12ae0","0x40082ae0",890,890,"R"],["0x12e60","0x40082e60",0,524336,"RW"]],"binSize":11866},
  {"name":"guest bss first","order":"b,t,r","syms":[["40080000","b","_RNvCsieMabytS3dp_5hello7COUNTER.0"],["40080000","B","__bss_start"],["40080000","B","__image_start"],["40080020","b","_RNvNtCsd92i63ulmgm_5guest7console7BACKEND.0"],["40080030","B","__stacks_start"],["40100030","B","__bss_end"],["40100030","B","__stacks_end"],["40100800","T","_start"],["40100878","T","_secondary_start"],["40101000","T","guest_vectors"],["4010365a","R","__image_end"]],"phdrs":[["0x10000","0x40080000",0,524336,"RW"],["0x10800","0x40100800",10976,10976,"RX"],["0x132e0","0x401032e0",890,890,"R"]],"binSize":11866},
  {"name":"guest bss in the middle","order":"t,b,r","syms":[["40080000","T","__image_start"],["40080000","T","_start"],["40080078","T","_secondary_start"],["40080800","T","guest_vectors"],["40082ae0","b","_RNvCsieMabytS3dp_5hello7COUNTER.0"],["40082ae0","B","__bss_start"],["40082b00","b","_RNvNtCsd92i63ulmgm_5guest7console7BACKEND.0"],["40082b10","B","__stacks_start"],["40102b10","B","__bss_end"],["40102b10","B","__stacks_end"],["40102e8a","R","__image_end"]],"phdrs":[["0x10000","0x40080000",10976,10976,"RX"],["0x12ae0","0x40082ae0",0,524336,"RW"],["0x12b10","0x40102b10",890,890,"R"]],"binSize":536202},
  {"name":"guest rodata first","order":"r,t,b","syms":[["40080000","R","__image_start"],["40080800","T","_start"],["40080878","T","_secondary_start"],["40081000","T","guest_vectors"],["400832e0","b","_RNvCsieMabytS3dp_5hello7COUNTER.0"],["400832e0","B","__bss_start"],["40083300","b","_RNvNtCsd92i63ulmgm_5guest7console7BACKEND.0"],["40083310","B","__stacks_start"],["40103310","B","__bss_end"],["40103310","B","__image_end"],["40103310","B","__stacks_end"]],"phdrs":[["0x10000","0x40080000",890,890,"R"],["0x10800","0x40080800",10976,10976,"RX"],["0x132e0","0x400832e0",0,524336,"RW"]],"binSize":13024},
];

for (const v of GUEST_VECTORS) {
  test(`matches rust-lld: ${v.name}`, () => {
    const s = { ...initialState("guest"), order: v.order.split(",").map((c) => CODE[c]) };
    const res = link(s);
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.symbols.map((x) => [x.addr.toString(16), x.letter, x.key]), v.syms, "llvm-nm -n");
    assert.deepEqual(
      res.phdrs.map((p) => ["0x" + p.offset.toString(16), "0x" + p.vaddr.toString(16), Number(p.filesz), Number(p.memsz), p.flags]),
      v.phdrs,
      "program headers",
    );
    assert.equal(Number(res.flat.size), v.binSize, "flat binary size");
  });
}

test("guest: the default layout starts with _start, so the raw load works", () => {
  const s = initialState("guest");
  const res = link(s);
  const out = rawLoad(s, res);
  assert.equal(out[1].status, "ok");
  assert.match(out[1].text, /The first bytes are _start/);
  assert.ok(!out.some((o) => o.status === "bad"));
  assert.match(summary(s, res), /first byte is _start/);
});

test("guest: .bss first keeps 2 KiB alignment and warns that the code moved", () => {
  const s = { ...initialState("guest"), order: ["bss", "text", "rodata"] };
  const res = link(s);
  const at = (id) => res.symbols.find((x) => x.id === id).addr;
  assert.equal(at("_start"), 0x40100800n);
  assert.equal(at("guest_vectors"), 0x40101000n);
  assert.equal(at("guest_vectors") % 2048n, 0n);
  const out = rawLoad(s, res);
  assert.equal(out[1].status, "warn");
  assert.match(out[1].text, /moved by -0x8_0800/);
});

test("guest: the script is guests/common/link.ld", () => {
  const t = scriptText(initialState("guest"));
  for (const line of ["EXTERN(_start)", "__image_start = .;", ".data : ALIGN(16) {", "*(COMMON)",
    ". += 8 * 0x10000;", "__image_end = .;", "*(.eh_frame .eh_frame_hdr)", "*(.note .note.*)"]) {
    assert.ok(t.includes(line), line);
  }
});

test("erratum 843419: the patch is listed and only a load/store pattern triggers it", () => {
  const s = step({ ...initialState("bare"), order: ["bss", "data", "text", "rodata"] }, { type: "stack", text: "0xfd0" });
  const res = link(s);
  const notes = res.notes.filter((n) => n.erratum);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].addr, 0x40081004n);
  assert.equal(res.code.find((c) => c.addr === 0x40081004n).text, "b\t0x4008101c");
  assert.equal(res.code.find((c) => c.addr === 0x4008101cn).text, "str\tw9, [x8, #0xfe0]");
  // An adrp followed by add (GREETING's pair, when too far to relax) is not the pattern.
  const words = new Uint8Array(16);
  [0x90000008, 0x91000108, 0xb9400109, 0xb9000109].forEach((w, i) => {
    words[i * 4] = w & 0xff; words[i * 4 + 1] = (w >>> 8) & 0xff; words[i * 4 + 2] = (w >>> 16) & 0xff; words[i * 4 + 3] = w >>> 24;
  });
  assert.deepEqual(erratumSites(words, 0x40080ff8n), []);
});

test("moveText names the new position", () => {
  const s = step(initialState("bare"), { type: "move", section: "rodata", delta: -1 });
  assert.equal(moveText(s, "rodata"), ".rodata moved to position 1 of 4, before .text.");
  const t = step(initialState("bare"), { type: "move", section: "text", delta: 1 });
  assert.equal(moveText(t, "text"), ".text moved to position 2 of 4, after .rodata.");
});

test("the primer's numbers: 68 bytes, llvm-size, readobj", () => {
  const res = link(initialState("bare"));
  assert.equal(res.flat.size, 68n);
  const bss = res.sections.find((s) => s.id === "bss");
  assert.equal(bss.size, 16400n); // llvm-size -A: .bss 16400
  const rw = res.phdrs[2];
  assert.equal(rw.filesz, 4n);
  assert.equal(rw.memsz, 16416n);
  assert.deepEqual(res.code.map((c) => c.text.replace("\t", " ")).slice(0, 3), [
    "sub sp, sp, #0x10", "nop", "adr x8, 0x40080038",
  ]);
  assert.equal(res.code[6].text, "ldr\tw9, [x8, #0x40]");
  assert.equal(res.code[13].text, "b\t0x40080028");
});

test("the .far experiment: 1,048,577 bytes", () => {
  let s = step(initialState("bare"), { type: "far", on: true });
  assert.deepEqual(s.order, ["text", "rodata", "data", "far", "bss"]);
  assert.equal(link(s).flat.size, 1048577n);
  const rows = hexRows(link(s).flat);
  assert.ok(rows.some((r) => r.type === "skip"), "the zero gap collapses");
});

test("the WHERE pointer reads 4000 0840 0000 0000", () => {
  const s = step(initialState("bare"), { type: "where", on: true });
  const res = link(s);
  const bytes = [];
  for (let i = 0x38n; i < 0x40n; i++) bytes.push(flatByte(res.flat, i));
  assert.deepEqual(bytes, [0x40, 0x00, 0x08, 0x40, 0, 0, 0, 0]);
  const moved = step(s, { type: "load", text: "0x4010_0000" });
  const out = rawLoad(moved, link(moved));
  assert.ok(out.some((o) => o.status === "bad" && o.text.includes("WHERE")));
});

test("chapter 03 guest: BSS at 0x40082e60, 11,866 bytes, __bss_end 0x40102e90", () => {
  const res = link(initialState("guest"));
  assert.equal(res.ok, true);
  const at = (id) => res.symbols.find((s) => s.id === id).addr;
  assert.equal(at("COUNTER"), 0x40082e60n);
  assert.equal(at("__bss_start"), 0x40082e60n);
  assert.equal(at("BACKEND"), 0x40082e80n);
  assert.equal(at("__bss_end"), 0x40102e90n);
  assert.equal(at("guest_vectors"), 0x40080800n);
  assert.equal(res.flat.size, 11866n);
  assert.equal(hexRows(res.flat)[0].type, "opaque");
  // llvm-nm order from captures/03-bss-nm.txt.
  const names = res.symbols.map((s) => s.name).filter((n) => /COUNTER|BACKEND|__bss/.test(n));
  assert.deepEqual(names, ["hello::COUNTER (.0)", "__bss_start", "guest::console::BACKEND (.0)", "__bss_end"]);
});

test("rodata first: the CPU executes 'hell' as ldnp and faults", () => {
  const s = { ...initialState("bare"), order: ["rodata", "text", "data", "bss"] };
  const out = rawLoad(s, link(s));
  const bad = out.find((o) => o.status === "bad");
  assert.match(bad.text, /0x6c6c6568/);
  assert.match(bad.text, /"hell"/);
  assert.match(bad.text, /ldnp d8, d25, \[x11, #-0x140\]/);
});

test("default layout: _start runs, BSS not in the file", () => {
  const s = initialState("bare");
  const out = rawLoad(s, link(s));
  assert.equal(out[1].status, "ok");
  assert.ok(out.some((o) => o.text.includes("_start must zero it")));
  assert.match(summary(s, link(s)), /68 bytes/);
});

test("bss before data: BOOTS comes first and is udf #0x7", () => {
  const s = { ...initialState("bare"), order: ["bss", "data", "text", "rodata"] };
  const out = rawLoad(s, link(s));
  assert.match(out.find((o) => o.status === "bad").text, /udf #0x7/);
});

test("backward .far is refused with an explanation", () => {
  let s = step(initialState("bare"), { type: "far", on: true });
  s = step(s, { type: "farAddr", text: "0x4000_0000" });
  const res = link(s);
  assert.equal(res.ok, false);
  assert.match(res.error, /backwards/);
});

test("far section far away: relaxation stops (adrp + add)", () => {
  let s = step(initialState("bare"), { type: "far", on: true });
  s = step(s, { type: "farAddr", text: "0x40280000" });
  s = { ...s, order: ["text", "far", "rodata", "data", "bss"] };
  const res = link(s);
  assert.equal(res.code[1].text, "adrp\tx8, 0x40280000");
  assert.equal(res.code[2].text, "add\tx8, x8, #0x1");
});

test("input validation", () => {
  const s = initialState("bare");
  assert.ok(step(s, { type: "start", text: "0x40081000" }).errors.start);
  assert.ok(step(s, { type: "start", text: "zz" }).errors.start);
  assert.ok(step(s, { type: "stack", text: "0x4001" }).errors.stack);
  assert.ok(step(s, { type: "stack", text: "0x80000000" }).errors.stack);
  assert.ok(step(s, { type: "load", text: "0x40080002" }).errors.load);
  assert.equal(parseHex("0x4008_0000"), 0x40080000n);
  assert.equal(parseHex("0x" + "f".repeat(17)), null);
  assert.equal(step(initialState("guest"), { type: "where", on: true }).where, false);
});

test("top of the address space is an error, not a wrap", () => {
  let s = step(initialState("bare"), { type: "start", text: "0xffff_ffff_ffff_0000" });
  s = step(s, { type: "stack", text: "0x10000" });
  const res = link(s);
  assert.equal(res.ok, false);
});

test("a gigabyte-sized flat binary is described, never allocated", () => {
  let s = step(initialState("bare"), { type: "far", on: true });
  s = step(s, { type: "farAddr", text: "0x8000_0000" });
  const res = link(s);
  assert.ok(res.flat.size > 0x3ff00000n);
  const rows = hexRows(res.flat);
  assert.ok(rows.length < 40);
});

test("share state round-trips and rejects junk", () => {
  let s = step(initialState("bare"), { type: "where", on: true });
  s = step(s, { type: "far", on: true });
  s = step(s, { type: "move", section: "rodata", delta: -1 });
  s = step(s, { type: "load", text: "0x40100000" });
  const h = encodeHash(s);
  assert.equal(h, "p:bare;o:r-t-d-f-b;s:40080000;k:4000;f:40180000;w:1;l:40100000");
  const back = decodeHash(h);
  assert.deepEqual(back.order, s.order);
  assert.equal(back.load, s.load);
  assert.equal(back.where, true);
  assert.deepEqual(decodeHash("o:t-t-t-t;s:<script>").order, ["text", "rodata", "data", "bss"]);
  assert.equal(decodeHash(null).preset, "bare");
  assert.equal(decodeHash("p:guest").preset, "guest");
});

test("moveTo and move keep a permutation", () => {
  let s = initialState("bare");
  s = step(s, { type: "moveTo", section: "bss", index: 0 });
  assert.deepEqual(s.order, ["bss", "text", "rodata", "data"]);
  assert.equal(step(s, { type: "move", section: "bss", delta: -1 }), s);
});

test("script text reflects the state", () => {
  let s = step(initialState("bare"), { type: "far", on: true });
  const t = scriptText(s);
  assert.match(t, /\. = 0x40080000;/);
  assert.match(t, /\.far 0x40180000 : \{ BYTE\(1\) \}/);
  assert.match(t, /\. \+= 0x4000;/);
});

test("disasm of the words the lab names", () => {
  assert.equal(disasm(0, 0n), "udf\t#0x0");
  assert.equal(disasm(0xdeadbeef, 0n), null);
  assert.equal(hex(0x40080000n), "0x4008_0000");
  assert.ok(PRESETS.bare.canWhere);
});
