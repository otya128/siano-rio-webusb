#!/usr/bin/env python3
"""Regenerate tuning golden traces by compiling the ORIGINAL C functions with fake USB.
Requires a C compiler and the upstream checkout. Does not access hardware.
"""
import pathlib, re, subprocess, tempfile, json, sys
source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '../BonD_FSUSB2i_Card/src')
text = (source / 'it9175.c').read_text()
priv = (source / 'it9175_priv.h').read_text()
# Preserve upstream function bodies, replacing only OS-dependent surroundings.
parts = [text[text.index('/* write multiple registers */'):text.index('static uint8_t calc_lrc')],
         text[text.index('static unsigned int it9175_div'):text.index('/* public function */')]]
priv = priv[priv.index('#define USB_TIMEOUT'):]
program = r'''
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
typedef void* HANDLE;
typedef void* PMUTEX;
#define ARRAY_SIZE(x) (sizeof(x)/sizeof(x[0]))
#define TS_BulkSize 305
#define warn_info(...) ((void)0)
#define warn_msg(...) ((void)0)
#define dmsgn(...) ((void)0)
#define miliWait(...) ((void)0)
#define opr_div(A,B,C) {C = A / B; A = A % B;}
'''+priv+r'''
static uint8_t registers[0x1000000];
static int it9175_ctrl_msg(struct state_st* s, uint8_t cmd, uint8_t mailbox, uint8_t wlen, uint8_t rlen) {
    unsigned addr = ((unsigned)mailbox << 16) | ((unsigned)s->buf[8] << 8) | s->buf[9];
    unsigned len = s->buf[4];
    if (cmd == CMD_MEM_WR) {
        printf("[%u,[", addr);
        for (unsigned i=0; i<len; i++) { registers[addr+i] = s->buf[10+i]; printf("%s%u", i ? "," : "", s->buf[10+i]); }
        puts("]]");
    } else if (cmd == CMD_MEM_RD) {
        memcpy(s->buf+3, registers+addr, len);
    } else return -1;
    return 0;
}
'''+ '\n'.join(parts)+r'''
int main(int argc, char** argv) {
    struct state_st s = {0};
    s.tunerID = 0x70;
    registers[0x80ec86] = atoi(argv[1]);
    registers[0x80ed03] = 8;
    registers[0x80ed23] = 0xe9;
    registers[0x80ed24] = 0x15;
    registers[0x80ec82] = 1;
    registers[0x8001dc] = 1;
    if (it9175_tuner_init(&s)) return 1;
    for (int i=2; i<argc; i++) {
      registers[0x8001c6] = 1;
      if (it9175_set_params(&s, atoi(argv[i]))) return 1;
    }
    return 0;
}
'''
frequencies = [53000, 90143, 164143, 192143, 230143, 312000, 444000, 473143, 629143, 859999]
with tempfile.TemporaryDirectory() as temp:
    c = pathlib.Path(temp) / 'trace.c'
    exe = pathlib.Path(temp) / 'trace'
    c.write_text(program)
    subprocess.run(['cc', '-std=c99', '-w', str(c), '-o', str(exe)], check=True)
    traces = []
    for mode in [0, 1, 2]:
        result = subprocess.run([str(exe), str(mode), *map(str, frequencies)], capture_output=True, text=True, check=True)
        traces.append({'mode': mode, 'frequencies': frequencies, 'writes': [json.loads(line) for line in result.stdout.splitlines()]})
    dest = pathlib.Path(__file__).resolve().parent.parent / 'test' / 'fixtures'
    dest.mkdir(exist_ok=True)
    (dest / 'c-tuning-traces.json').write_text(json.dumps(traces, separators=(',', ':'))+'\n')
    print('Generated original-C reference traces for three clock modes')
