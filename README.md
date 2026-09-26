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
- `examples/i4004.fetl` — Intel 4004 architectural compatibility sample
- `examples/i4004_demo.hex` — small demo program

The 4004 file expands to roughly 12k nets and 24k MOS switches in the current version. Its register/address decoders and datapath are ordinary FetLoom modules; there is no special CPU or decoder implementation in the simulator.

### Running the 4004 demo

1. Select `Intel 4004 architectural sample`.
2. Compile with top module `main`.
3. Set `reset=1`, run for several ticks, then set `reset=0`.
4. Add probes for `main.acc[*]`, `main.pc[*]`, and `main.rom_port[*]`, or drill into `main/i4004#...`.
5. The demo ROM initializes R0/R1, repeatedly adds them, writes the result to the ROM port, increments R0, and jumps back.

## Tests

```bash
node tests/test.mjs
```

The test suite parses/elaborates every example, instantiates the checked-in WASM core, checks inverter behavior and the full-adder truth table, and verifies that the 4004 example expands successfully.

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
