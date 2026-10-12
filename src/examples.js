// Example catalogue shared by the browser UI, the layout prebuild tool and the tests.
export const EXAMPLES = [
  {name:'Inverter', file:'examples/inverter.fetl', demo:{waves:['a','y'], hint:'Toggle a to see the inverter output.'}},
  {name:'NAND + AND', file:'examples/logic.fetl', demo:{waves:['a','b','nand_y','and_y','/nand2#0._0','/and2#1._0','/and2#1/nand2#0._0'], hint:'Toggle a and b to compare NAND and AND.'}},
  {name:'Full adder', file:'examples/fulladder.fetl', demo:{waves:['a','b','cin','sum','cout','/fulladder#0._x','/fulladder#0._c0','/fulladder#0._c1'], groups:[{name:'Result',signals:'main.sum, main.cout'}], hint:'Toggle a, b and cin; Result is the two-bit sum.'}},
  {name:'Clocked latch', file:'examples/latch.fetl', demo:{waves:['d','clk_out','q','/dff#1._master','/dff#1/dlatch#1._stored','/dff#1/dlatch#2._stored'], inputs:{d:1}, hint:'Run, then toggle d to see it captured at the clock edge.'}},
  {name:'ROM/RAM demo', file:'examples/memory.fetl', demo:{waves:['clk_out','we','addr[0]','rom_data[0]','ram_data[0]'], groups:['addr','din','rom_data','ram_data'], inputs:{din:42,we:1}, hint:'Run to write 42 to RAM. Turn we off and change addr to inspect memory.'}},
  {name:'4-bit counter', file:'examples/counter4.fetl', demo:{waves:['clk_out','carry','q[0]','q[1]','q[2]'], groups:['q'], inputs:{en:1}, resetTicks:16, hint:'Run to count. Toggle en to pause counting.'}},
  {name:'4-bit ALU', file:'examples/alu4.fetl', demo:{waves:['carry','zero','y[0]','y[1]','y[2]'], groups:['a','b','op','y'], inputs:{a:3,b:5}, hint:'Change op: 0 ADD, 1 SUB, 2 AND, 3 XOR.'}},
  {name:'4x4 register file', file:'examples/regfile4.fetl', demo:{waves:['clk_out','we','din[0]','dout[0]','reset'], groups:['waddr','raddr','din','dout'], inputs:{we:1,din:9}, resetTicks:16, hint:'Run to write 9. Turn we off and change raddr to read a register.'}},
  {name:'TD4 4-bit CPU', file:'examples/td4.fetl', demo:{waves:['clk_out','reset','pc[0]','pc[1]','out[0]'], groups:['in','out','pc'], resetTicks:24, hint:'Run to execute the demo ROM; watch PC and OUT.'}},
  {name:'Intel 4004 architectural sample', file:'examples/i4004.fetl', demo:{waves:['_clk','carry','reset','acc[0]','pc[0]','rom_port[0]'], inputs:{test:1}, groups:['acc','pc','rom_port','ram_port0','ram_port1','ram_port2','ram_port3'], resetTicks:32, hint:'Run to execute the demo ROM; watch ACC, PC and ROM port.'}},
];
