#include <stdint.h>

#define MAX_NETS 65536
#define MAX_DEV 200000
#define MAX_CHANGED 65536
#define Z 2
#define X 3

static uint32_t n_nets=0, n_dev=0;
static uint8_t values[MAX_NETS];
static uint8_t before_values[MAX_NETS];
static uint8_t prev_values[MAX_NETS];
static uint8_t drives[MAX_NETS];
static uint8_t caps[MAX_NETS];
static uint8_t dev_type[MAX_DEV];
static uint32_t dev_gate[MAX_DEV], dev_a[MAX_DEV], dev_b[MAX_DEV];
static uint32_t parent[MAX_NETS];
static uint8_t strong[MAX_NETS], weak[MAX_NETS];
static uint32_t changed_net[MAX_CHANGED];
static uint8_t changed_val[MAX_CHANGED];
static uint32_t n_changed=0;

static uint32_t findp(uint32_t x){
  while(parent[x]!=x){ parent[x]=parent[parent[x]]; x=parent[x]; }
  return x;
}
static void unite(uint32_t a,uint32_t b){
  a=findp(a); b=findp(b); if(a!=b) parent[b]=a;
}
static uint8_t mergev(uint8_t a,uint8_t b){
  if(a==Z) return b; if(b==Z) return a; if(a==b) return a; return X;
}

__attribute__((export_name("init_core")))
uint32_t init_core(uint32_t nets, uint32_t devs){
  if(nets>MAX_NETS || devs>MAX_DEV) return 0;
  n_nets=nets; n_dev=devs; n_changed=0;
  for(uint32_t i=0;i<n_nets;i++){ values[i]=Z; prev_values[i]=Z; drives[i]=Z; caps[i]=0; }
  return 1;
}

__attribute__((export_name("set_device")))
uint32_t set_device(uint32_t i,uint32_t type,uint32_t gate,uint32_t a,uint32_t b){
  if(i>=n_dev || gate>=n_nets || a>=n_nets || b>=n_nets) return 0;
  dev_type[i]=(uint8_t)type; dev_gate[i]=gate; dev_a[i]=a; dev_b[i]=b; return 1;
}

__attribute__((export_name("set_cap")))
void set_cap(uint32_t net,uint32_t on){ if(net<n_nets) caps[net]=on?1:0; }

__attribute__((export_name("clear_drives")))
void clear_drives(void){ for(uint32_t i=0;i<n_nets;i++) drives[i]=Z; }

__attribute__((export_name("drive")))
void drive(uint32_t net,uint32_t val){ if(net<n_nets && val<=X) drives[net]=mergev(drives[net],(uint8_t)val); }

__attribute__((export_name("force_value")))
void force_value(uint32_t net,uint32_t val){ if(net<n_nets && val<=X) values[net]=(uint8_t)val; }

__attribute__((export_name("solve")))
uint32_t solve(void){
  for(uint32_t i=0;i<n_nets;i++) before_values[i]=values[i];
  for(uint32_t iter=0;iter<64;iter++){
    for(uint32_t i=0;i<n_nets;i++){ prev_values[i]=values[i]; parent[i]=i; strong[i]=Z; weak[i]=Z; }
    for(uint32_t d=0;d<n_dev;d++){
      uint8_t gv=prev_values[dev_gate[d]];
      uint8_t on=(dev_type[d]==0)?(gv==1):(gv==0);
      if(on) unite(dev_a[d],dev_b[d]);
    }
    for(uint32_t i=0;i<n_nets;i++) parent[i]=findp(i);
    for(uint32_t i=0;i<n_nets;i++){
      uint32_t r=parent[i];
      if(drives[i]!=Z) strong[r]=mergev(strong[r],drives[i]);
      if(caps[i] && (prev_values[i]==0 || prev_values[i]==1)) weak[r]=mergev(weak[r],prev_values[i]);
    }
    uint32_t diff=0;
    for(uint32_t i=0;i<n_nets;i++){
      uint32_t r=parent[i]; uint8_t nv = strong[r]!=Z ? strong[r] : weak[r];
      if(values[i]!=nv){ values[i]=nv; diff++; }
    }
    if(!diff) break;
  }
  n_changed=0;
  for(uint32_t i=0;i<n_nets;i++) if(values[i]!=before_values[i] && n_changed<MAX_CHANGED){ changed_net[n_changed]=i; changed_val[n_changed]=values[i]; n_changed++; }
  return n_changed;
}

__attribute__((export_name("get_value")))
uint32_t get_value(uint32_t net){ return net<n_nets?values[net]:X; }
__attribute__((export_name("get_changed_count")))
uint32_t get_changed_count(void){ return n_changed; }
__attribute__((export_name("get_changed_net")))
uint32_t get_changed_net(uint32_t i){ return i<n_changed?changed_net[i]:0; }
__attribute__((export_name("get_changed_value")))
uint32_t get_changed_value(uint32_t i){ return i<n_changed?changed_val[i]:X; }
