# FetLoom

FetLoom is a browser-based MOS switch-level circuit DSL and simulator. A `.fetl` file starts from `Nmos`, `Pmos`, `Vcc`, `Gnd`, optional `Cap`, `Clk`, `Rom`, and `Ram`, then builds reusable modules all the way up to CPU-scale structures.

## Run

No package installation is required. Serve the directory over HTTP because browsers normally do not allow local `fetch()` of WASM/ROM files.

```bash
cd FetLoom
python3 -m http.server 8000
```

Open `http://localhost:8000/`.

The checked-in `wasm/fetloom_core.wasm` is already built.

## Rebuild the WASM core

The small core is written in freestanding C and compiles directly to WebAssembly with clang:

```bash
cd wasm
./build.sh
```

The browser owns parsing, hierarchy, clocks, ROM/RAM orchestration, layout, and probe traces. WASM owns the flattened MOS connected-component solve.

## Language example

```fetl
module inv(a -> y) {
  Pmos(a, Vcc, y)
  Nmos(a, y, Gnd)
}

module nand2(a, b -> y) {
  Pmos(a, Vcc, y)
  Pmos(b, Vcc, y)
  Nmos(a, y, _0)
  Nmos(b, _0, Gnd)
}

module and2(a, b -> y) {
  nand2(a, b, _0)
  inv(_0, y)
}
```

`_0` is a declaration-free local net. `Nmos/Pmos/Vcc/Gnd` are visibly different because PascalCase is reserved for simulator-defined elements.

## Included examples

- `examples/inverter.fetl`
- `examples/logic.fetl`
- `examples/fulladder.fetl`
- `examples/latch.fetl` — dynamic storage using `Cap`
- `examples/memory.fetl` — `Rom` and `Ram`
- `examples/counter4.fetl` — 4-bit synchronous counter (incrementer + enable mux + flip-flops)
- `examples/alu4.fetl` — 4-bit ALU (ADD/SUB/AND/XOR, carry, zero) with a 2-to-4 op decoder
- `examples/regfile4.fetl` — 4×4-bit register file: write-address decoder, write enables, read mux tree
- `examples/td4.fetl` + `examples/td4_demo.hex` — TD4, the 4-bit teaching CPU from 『CPUの創りかた』 (A/B/OUT/PC, carry flag, 16-byte ROM)
- `examples/i4004.fetl` — Intel 4004 architectural compatibility sample
- `examples/i4004_demo.hex` — small demo program

The 4004 file expands to roughly 12k nets and 24k MOS switches in the current version. Its register/address decoders and datapath are ordinary FetLoom modules; there is no special CPU or decoder implementation in the simulator.

### Running the 4004 demo

1. Select `Intel 4004 architectural sample`.
2. Compile with top module `main`.
3. Set `reset=1`, run for several ticks, then set `reset=0`.
4. Add probes for `main.acc[*]`, `main.pc[*]`, and `main.rom_port[*]`, or drill into `main/i4004#...`.
5. The demo ROM initializes R0/R1, repeatedly adds them, writes the result to the ROM port, increments R0, and jumps back.

## Die layout view

The **Die layout** tab shows the circuit as a chip: a square die with bonding pads, a metal3
Vcc/Gnd comb and every MOS transistor drawn on the masks of a 3-metal CMOS process
(N-well, P+/N+ select, active, poly, contact, metal1, via1, metal2, via2, metal3, overglass).

- **Floorplan.** Large modules (ALU, register file, decoder, multiplexers, …) become rectangular
  hard blocks; small modules are flattened into the transistor field of their parent. Items are
  bipartitioned recursively with an area-balanced min-cut (Fiduccia–Mattheyses) and packed with
  slicing shape functions, then stretched so the core is a square of uniform transistor density.
  Blocks whose estimated routing demand is too high get wider channels and the floorplan is redone.
- **Routing.** Each hard block is routed on a two-layer grid (metal1 preferred horizontal,
  metal2 preferred vertical) by an A* maze router with negotiated congestion (rip-up and
  reroute). Nets that leave a block get pins on its edge, placed between the outside and the
  inside connections.
- **Length matching.** Point-to-point bits of the same bus are tuned to the length of the longest
  bit with serpentine (zigzag) detours.
- **Two drawing modes.** *Mask pattern* shows the manufacturing masks: toggle layers in the legend,
  or pick a single mask to see it as a photomask plate. *Schematic* is a separate, readability-first
  layout that ignores the die placement (`src/schematic.js`):
  - every module is a box drawn with inputs on the left and outputs on the right, but the parent may
    mirror it so that its pins face what they connect to — on screen signals can enter from either
    side; ports along an edge follow the order of the logic they feed, to avoid crossings;
  - children are arranged in signal-flow columns (barycentre ordering, tall columns split, wide
    drawings folded into bands) so the box is filled evenly in two dimensions;
  - transistor-only cells use the textbook CMOS arrangement (PMOS row over NMOS row) with MOS,
    Vcc and ground symbols;
  - child boxes are shrunk to what their pins need; zooming in reveals their contents (level of detail);
  - wires are routed per module so they cross but do not overlap, and nets that connect the same
    pins (a bus) are one thick line labelled with its name and current value (amber when bits disagree).
- **Voltage.** While simulating, wires, gates and diffusion are coloured by their logic level
  (red = 1, blue = 0, grey = Z, magenta = X); transistor channels turn green when conducting.
  Click a wire to probe it, double-click to zoom into a block. Remaining routing conflicts, if
  any, are marked with magenta circles.

Both layouts are expensive for the 4004 (about 6 minutes for the die, 1 minute for the schematic),
so they are computed ahead of time and cached:

```bash
npm run layouts            # rebuild stale layouts/*.fdie.gz, *.fsch.gz + layouts/manifest.json
npm run layouts -- --force # rebuild all
npm run layouts -- td4     # rebuild one example
```

Each cache key is a hash of the algorithm version, the top module and the source text.
The browser first looks the key up in `layouts/manifest.json`; on a miss (edited source) it
computes the layout in a Web Worker and stores it in IndexedDB, so it is computed only once.
`node tests/test.mjs` fails when a prebuilt layout is stale.

## Tests

```bash
node tests/test.mjs
```

The test suite parses/elaborates every example, instantiates the checked-in WASM core, checks inverter behavior, the full-adder and 4-bit ALU truth tables, the counter, register file and TD4 programs, verifies that the 4004 example expands successfully, checks die layout invariants/determinism, and verifies that the prebuilt layout cache matches the example sources.

## Project layout

```text
FetLoom/
  index.html
  styles.css
  src/
    app.js       browser UI
    dsl.js       parser + hierarchical elaborator
    layout.js    hierarchy-aware SVG auto-layout
    sim.js       WASM wrapper, clocks, memories, probes
    examples.js  example catalogue
    die.js       die floorplan / placement / routing / mask geometry
    die-format.js binary layout container
    die-cache.js prebuilt + IndexedDB layout cache, worker orchestration
    die-worker.js layout computation off the UI thread
    die-view.js  WebGL2 viewer (mask / schematic modes) with live voltage colouring
    schematic.js readable nested schematic layout + routing, independent of the die
  tools/
    build-layouts.mjs  precompute layouts for the examples
  layouts/       prebuilt layout cache (*.fdie.gz, *.fsch.gz + manifest.json)
  wasm/
    fetloom_core.c
    fetloom_core.wasm
    build.sh
  docs/
    SPEC.md
    REFERENCES.md
  examples/
  tests/
```

## Current scope

FetLoom is intentionally switch-level and educational rather than SPICE-like. It models 0/1/X/Z connectivity, not transistor analog behavior or propagation delay. The 4004 model targets architectural/ISA behavior and does not claim pin-cycle or transistor-layout identity with the original silicon.
