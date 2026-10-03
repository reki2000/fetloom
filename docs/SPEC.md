# FetLoom DSL Specification 0.1

FetLoom is a small switch-level circuit DSL whose semantic atoms are MOS switches and nets. The goal is to keep source code focused on circuitry rather than HDL bookkeeping.

## 1. File and naming

- Product / simulator name: **FetLoom**
- Source extension: **`.fetl`**
- User module names: lowercase or snake_case, e.g. `nand2`, `full_adder`
- Ordinary port names: lowercase or snake_case
- Local nets: begin with `_`, e.g. `_0`, `_carry`, `_alu_out`
- Built-in simulator elements: PascalCase and reserved, e.g. `Nmos`, `Pmos`, `Vcc`, `Gnd`, `Cap`, `Clk`, `Rom`, `Ram`

A normal unknown name is an error. It is never silently turned into a wire. A local name beginning with `_` is created implicitly when first used.

## 2. Core syntax

```fetl
module nand2(a, b -> y) {
  Pmos(a, Vcc, y)
  Pmos(b, Vcc, y)
  Nmos(a, y, _0)
  Nmos(b, _0, Gnd)
}
```

A module signature is:

```text
module name(input-port-list -> output-port-list) { statements }
```

The arrow may be omitted when there are no output ports.

Ports can be buses:

```fetl
module mux4(a[4], b[4], sel -> y[4]) { ... }
```

Bus bit 0 is the least significant bit by convention.

## 3. Approximate grammar

```ebnf
source        = { module } ;
module        = "module" user-id "(" [ ports ] [ "->" ports ] ")" "{" { call } "}" ;
ports         = port { "," port } ;
port          = user-id [ "[" integer "]" ] ;
call          = identifier "(" [ args ] ")" [ ";" ] ;
args          = arg { "," arg } ;
arg           = signal | integer | string ;
signal        = identifier [ "[" integer "]" ] ;
user-id       = lower { lower | digit | "_" } ;
local-id      = "_" { letter | digit | "_" } ;
```

Comments are `// ...`, `# ...`, or `/* ... */`.

## 4. Nets and scoping

`Vcc` and `Gnd` are global built-in nets. All ports and `_local` nets are module-local before elaboration. Module instances create hierarchical net names such as:

```text
main/alu#2/fulladder#0._carry
```

Local nets need no declaration:

```fetl
module and2(a, b -> y) {
  nand2(a, b, _0)
  inv(_0, y)
}
```

Bus width is inferred from the connected module port when possible. A local bus should therefore first appear where the expected width is known.

## 5. Built-ins

### `Nmos(gate, a, b)`

An NMOS switch joins terminals `a` and `b` when `gate == 1`.

### `Pmos(gate, a, b)`

A PMOS switch joins terminals `a` and `b` when `gate == 0`.

The simulator intentionally treats source and drain as symmetric switch terminals. Threshold voltage, analog resistance, body effect, and degraded pass levels are outside version 0.1.

### `Vcc`, `Gnd`

`Vcc` is a strong logical `1` source. `Gnd` is a strong logical `0` source.

### `Cap(net)`

Marks a net as charge-retaining. If its connected switch component has no strong driver, the last stable `0` or `1` can be retained. This is intended for dynamic storage experiments and simple latches, not analog capacitance simulation.

### `Clk(periodTicks, out)`

Produces a square-wave driver. `periodTicks` is the half-period in simulator ticks.

```fetl
Clk(8, _clk)
```

### `Rom("file.hex", addressBus, dataBus)`

Asynchronous read-only memory. The file is whitespace/comma separated hexadecimal bytes. Address bit 0 is the LSB. Data widths larger than 8 bits are currently not populated beyond the low byte.

### `Ram(addressBus, dataInBus, dataOutBus, we, clk)`

Asynchronous read, rising-edge synchronous write RAM. `dataInBus` and `dataOutBus` must have equal widths. The current browser implementation stores words as JavaScript unsigned integers.

There is intentionally **no built-in address decoder, adder, register, mux, flip-flop, ALU, CPU, or logic gate**. Such circuits belong in `.fetl` source.

## 6. Logic model

Every net has one of four values:

- `0`: low
- `1`: high
- `Z`: undriven/floating
- `X`: conflicting/unknown

On each solve pass, FetLoom:

1. decides which MOS switches are on from their gate values;
2. forms connected net components;
3. resolves strong drivers in each component;
4. produces `X` if strong 0 and strong 1 conflict;
5. if there is no strong driver, consults retained `Cap` values;
6. otherwise resolves the component to `Z`;
7. repeats until stable or the iteration limit is reached.

This is a switch-level digital approximation rather than an electrical SPICE model.

## 7. Modules and elaboration

User modules are structural macros. During elaboration the simulator recursively expands them to a flat MOS/net graph for the WASM solver while retaining the hierarchy tree for visualization.

Instances need no explicit names. FetLoom assigns stable synthetic names in source order, for example `nand2#0`.

## 8. Simulation API concept

The browser implementation exposes these conceptual operations:

```text
compile(source, topModule)
reset()
step()
run()
setInput(port, value)
probe(net)
```

The WASM core receives the flattened transistor graph and returns net changes. Memory devices, clock sources, hierarchy, and traces are orchestrated by the browser layer.

## 9. Visualization

The UI preserves module hierarchy even though the solver is flattened. The current auto-layout:

- places inputs on the left and outputs on the right;
- estimates module levels from producer/consumer connectivity;
- uses orthogonal wire routing;
- allows double-click drill-down into user modules;
- colors wires by current 0/1/X/Z state;
- lets a wire or port be clicked to add/remove a probe.

The probe pane stores the most recent 512 samples per selected net and renders a live digital waveform.

### Die layout view

A second visualization renders the elaborated circuit as a physical die (see `src/die.js`):

- the top module is the core; its ports become bonding pads, Vcc/Gnd are distributed by a metal3 comb;
- modules with at least `max(64, transistors/150)` transistors are hard blocks with their own ring and pins;
  smaller modules are flattened into the parent's transistor field;
- placement: FM min-cut bisection + slicing shape functions, stretched to a square of uniform density;
- routing: per hard block, metal1/metal2 grid A* router with negotiated congestion;
- bus bits with exactly two terminals in a block are length-matched with serpentine detours;
- geometry: rectangles on 12 masks (`nwell pselect nselect active poly contact metal1 via1 metal2 via2 metal3 glass`).

The result is stored as `FDIE` binary (`src/die-format.js`): magic, version, JSON header (blocks, pads,
layer ranges, statistics), then `Int32` records `[x, y, w, h, layer | flags << 8, net]` in lambda units.
Channel rects carry `flags` 1 (NMOS) / 2 (PMOS) and the gate net so the viewer can show conduction.
Layouts are cached by `layoutKey(source, top)`.

## 10. 4004 sample policy

`examples/i4004.fetl` follows these rules:

- instruction decode, register select decode, ALU, PC increment, register file, latches/registers, DCL command-line logic, muxes, and port latches are FetLoom modules;
- `Rom`, `Ram`, `Cap`, and `Clk` are the only state/environment primitives used;
- no `Decoder` built-in exists;
- the CPU presents explicit memory/port control signals;
- the demo harness uses four RAM banks and explicitly derives CM-RAM selection in DSL.

The sample is an architectural compatibility model intended for learning and ISA experimentation. It does not reproduce the original 4004 transistor topology, voltage conventions, four-bit multiplexed package bus timing, or analog characteristics. `WPM` is decoded and exposed as an external program-memory write pulse, but the included demo harness connects a static `Rom`, so the demo does not self-modify program memory.

## 11. Deliberate omissions in 0.1

Version 0.1 does not yet include parameters, generate loops, symbolic constants, include/import, analog delay, transistor strength, threshold loss, source/drain distinction, bidirectional top-level ports, or a timing-delay model. These can be added without changing the core naming/scoping rules.
