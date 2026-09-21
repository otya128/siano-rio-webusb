#!/usr/bin/env python3
"""Import numeric tables verbatim from the upstream source (no C runtime needed)."""
import pathlib, re, sys
source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '../BonD_FSUSB2i_Card/src')
out = pathlib.Path(__file__).resolve().parent.parent / 'src'
def body(file, name):
    text = (source / file).read_text()
    text = re.sub(r'/\*.*?\*/|//[^\n]*', '', text, flags=re.S)
    return re.search(r'\b' + name + r'\s*\[[^\]]*\]\s*=\s*\{(.*?)\}\s*;', text, re.S).group(1)
def values(file, name):
    return [int(n.strip(), 0) for n in body(file, name).split(',') if n.strip()]
header = '// Ported from BonD_FSUSB2i_Card (c) 2015-2016 trinity19683. GPL-3.0-only.\n'
text = header
for file, name in [('it9175_priv.h', 'inittab_1'), ('it9175_priv.h', 'inittab_2'), ('it9175.c', 'params_1'), ('it9175.c', 'params_2'), ('it9175.c', 'SDRAM_CLK')]:
    nums = values(file, name)
    text += f'export const {name} = new Uint8Array([\n'
    text += '\n'.join('  ' + ', '.join(f'0x{n:02x}' for n in nums[i:i+16]) + ',' for i in range(0, len(nums), 16)) + '\n]);\n'
for name in ['init1_mtab', 'init2_mtab', 'init3_mtab', 'init4_mtab']:
    triples = re.findall(r'\{([^}]+)\}', body('it9175.c', name))
    text += f'export const {name}: readonly (readonly [number, number, number])[] = [\n'
    text += '\n'.join('  [' + triple.strip() + '],' for triple in triples) + '\n];\n'
(out / 'tables.ts').write_text(text)
nums = values('it9175_fw.h', 'it9179_fw1')
text = header + '// Firmware: Copyright (C) 2013 ITE Technologies, Inc.; IT9175BDA.sys (2013-02-27).\n'
text += 'export const firmware = new Uint8Array([\n'
text += '\n'.join('  ' + ','.join(f'0x{n:02x}' for n in nums[i:i+24]) + ',' for i in range(0, len(nums), 24)) + '\n]);\n'
(out / 'firmware-data.ts').write_text(text)
print(f'Imported tables and {len(nums)} firmware bytes')
