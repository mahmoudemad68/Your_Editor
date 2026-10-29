#!/bin/sh
# Fixed upstream inputs only. Source/network preparation and offline compilation
# are separate BuildKit RUN instructions; this script cannot enable that network.
set -eu
cd /build
export GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1
export GOMAXPROCS=2 GOMEMLIMIT=5GiB
export GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
export GOPRIVATE= GONOPROXY= GONOSUMDB=
# No implicit caller flags may alter bootstrap, verification or either build.
if [ -n "${GOFLAGS:-}" ] || [ -n "${GOEXPERIMENT:-}" ]; then
  echo 'unapproved Go build environment' >&2; exit 1
fi
test "$(go env GOVERSION)" = go1.26.10

case "${1:-}" in
bootstrap)
  cat > /build/check.go <<'GO'
package main
import("encoding/json";"crypto/sha256";"fmt";"os";"io";"strings";"os/exec";"syscall";"time";"debug/elf";"debug/buildinfo")
type Module struct { Path,Version,Sum,GoModSum,Zip,GoMod string; Replace *Module }
type Input struct { Source map[string]interface{}; Modules map[string]struct{Version,Zip_sha256,Mod_sha256 string; Go_sum_lines []string}; Original_versions map[string]string; Build struct{Output_profile string; Diagnostic_only bool} }
func must(e error){if e!=nil{panic(e)}}
func file(p string)[]byte{b,e:=os.ReadFile(p);must(e);return b}
func hash(p string)string{return fmt.Sprintf("%x",sha256.Sum256(file(p)))}
func modules(p string)map[string]Module {f,e:=os.Open(p);must(e);defer f.Close();d:=json.NewDecoder(f);r:=map[string]Module{};for{var m Module;e=d.Decode(&m);if e==io.EOF{break};must(e);if _,ok:=r[m.Path];ok{panic("duplicate module")};r[m.Path]=m};return r}
func sameReplace(a,b *Module)bool{if a==nil||b==nil{return a==nil&&b==nil};return a.Path==b.Path&&a.Version==b.Version&&sameReplace(a.Replace,b.Replace)}
const swProfile="seaweedfs-go-s-w-diagnostic-v1"
const originalLinkerFlags="-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=ffa87c2+editagent-sec1"
func linkerFlags(profile string)string{switch profile{case "":return originalLinkerFlags;case swProfile:return originalLinkerFlags+" -s -w";default:panic("unapproved linker profile")}}
func elfEvidence(output,flags string)map[string]interface{}{
 f,e:=elf.Open(output);must(e);defer f.Close();info,e:=os.Stat(output);must(e)
 bi,e:=buildinfo.ReadFile(output);must(e);if bi.GoVersion!="go1.26.10"{panic("ELF compiler drift")}
 settings:=map[string]string{};for _,v:=range bi.Settings{settings[v.Key]=v.Value};if settings["-trimpath"]!="true"||settings["CGO_ENABLED"]!="0"||settings["GOARCH"]!="amd64"||settings["GOAMD64"]!="v1"||settings["GOOS"]!="linux"{panic("ELF build setting drift")};if v,ok:=settings["-ldflags"];ok&&v!=flags{panic("ELF linker flag drift")}
 sums:=map[string]bool{};for _,v:=range strings.Split(string(file("/build/source/go.sum")),"\n"){sums[v]=true};graph:=modules("/build/after.json")
 for _,m:=range bi.Deps{g,ok:=graph[m.Path];if !ok||g.Version!=m.Version{panic("linked module graph drift")};p,v,sum:=m.Path,m.Version,m.Sum;if m.Replace!=nil{if g.Replace==nil||g.Replace.Path!=m.Replace.Path||g.Replace.Version!=m.Replace.Version{panic("linked replacement drift")};p,v,sum=m.Replace.Path,m.Replace.Version,m.Replace.Sum}else if g.Replace!=nil{panic("linked replacement missing")};if !sums[p+" "+v+" "+sum]||!strings.HasPrefix(sum,"h1:"){panic("linked module checksum missing")}}
 sections:=[]map[string]interface{}{};programs:=[]map[string]interface{}{};runtimePC,buildInfo:=false,false
 for _,s:=range f.Sections{if s.Name==".symtab"||s.Name==".strtab"||strings.HasPrefix(s.Name,".debug_")||strings.HasPrefix(s.Name,".zdebug_"){panic("diagnostic stripping profile mismatch")};if s.Name==".gopclntab"&&s.FileSize>0{runtimePC=true};if s.Name==".go.buildinfo"&&s.FileSize>0{buildInfo=true};disk:=s.FileSize;if s.Type==elf.SHT_NOBITS{disk=0};sections=append(sections,map[string]interface{}{"name":s.Name,"type":s.Type.String(),"flags":s.Flags.String(),"offset":s.Offset,"logical_bytes":s.Size,"file_bytes":disk,"address":s.Addr})}
 for _,p:=range f.Progs{if p.Type==elf.PT_INTERP||p.Flags&elf.PF_W!=0&&p.Flags&elf.PF_X!=0{panic("unsafe ELF program header")};programs=append(programs,map[string]interface{}{"type":p.Type.String(),"flags":p.Flags.String(),"offset":p.Off,"file_bytes":p.Filesz,"memory_bytes":p.Memsz,"virtual_address":p.Vaddr,"align":p.Align})}
 if !runtimePC||!buildInfo||len(bi.Deps)==0{panic("required Go runtime/build metadata missing")}
 return map[string]interface{}{"file_bytes":info.Size(),"class":f.Class.String(),"data":f.Data.String(),"type":f.Type.String(),"machine":f.Machine.String(),"entry":f.Entry,"sections":sections,"program_headers":programs,"go_build_info":bi,"linker_flags":flags,"embedded_ldflags":"Go omits -ldflags with -trimpath; exact invocation is separately recorded","baseline_sections":"UNKNOWN"}
}
func build(l Input,label,output string){
 flags:=linkerFlags(l.Build.Output_profile);if l.Build.Output_profile!=swProfile||!l.Build.Diagnostic_only||os.Getenv("GOFLAGS")!=""||os.Getenv("GOEXPERIMENT")!=""{panic("fixed diagnostic profile required")}

 entries,e:=os.ReadDir(os.Getenv("GOCACHE"));must(e);if len(entries)!=0{panic("compile cache is not empty")}
 started:=time.Now();cmd:=exec.Command("timeout","1500","go","build","-mod=readonly","-p=2","-trimpath","-buildvcs=false","-ldflags",flags,"-o",output,"./weed");cmd.Stdout=os.Stdout;cmd.Stderr=os.Stderr;must(cmd.Run())
 usage:=cmd.ProcessState.SysUsage().(*syscall.Rusage);visible:=map[string]string{}
 for _,name:=range []string{"cpu.max","cpu.stat","memory.max","memory.peak","pids.max"}{b,e:=os.ReadFile("/sys/fs/cgroup/"+name);if e==nil{visible[name]=string(b)}else{visible[name]="UNAVAILABLE"}}
 report:=map[string]interface{}{"label":label,"wall_seconds":time.Since(started).Seconds(),"max_rss_kib":usage.Maxrss,"user_seconds":float64(usage.Utime.Sec)+float64(usage.Utime.Usec)/1e6,"system_seconds":float64(usage.Stime.Sec)+float64(usage.Stime.Usec)/1e6,"cache_initially_empty":true,"elf_sha256":hash(output),"visible_cgroup_only":visible,"output_profile":l.Build.Output_profile,"diagnostic_marker":map[string]interface{}{"schema_version":1,"profile":swProfile,"diagnostic_only":true,"elf_sha256":hash(output),"flags_sha256":fmt.Sprintf("%x",sha256.Sum256([]byte(flags))),"source_commit":"ffa87c25fdf587178b1521ad87f2a4a72a02e584","go_version":"go1.26.10"},"elf":elfEvidence(output,flags)}
 b,e:=json.MarshalIndent(report,"","  ");must(e);must(os.WriteFile("/out/provenance/build-"+label+".json",append(b,'\n'),0644));fmt.Println("S_W_ELF_EVIDENCE",string(b))
}
func downloads(l Input,ms map[string]Module){if len(ms)!=2{panic("target count")};for p,w:=range l.Modules{m,ok:=ms[p];if !ok||m.Version!=w.Version||m.Replace!=nil||hash(m.Zip)!=w.Zip_sha256||hash(m.GoMod)!=w.Mod_sha256{panic("module archive mismatch: "+p)};if m.Sum!=strings.Fields(w.Go_sum_lines[0])[2]||m.GoModSum!=strings.Fields(w.Go_sum_lines[1])[2]{panic("sumdb mismatch: "+p)}}}
func graph(l Input,a,b map[string]Module,originalMod,effectiveMod,originalSum,effectiveSum string){if len(a)!=len(b){panic("dependency graph size changed")};for p,m:=range a{n,ok:=b[p];if !ok{panic("module removed")};if w,changed:=l.Modules[p];changed{if m.Version!=l.Original_versions[p]||n.Version!=w.Version||m.Replace!=nil||n.Replace!=nil{panic("target changed unexpectedly")}}else if m.Version!=n.Version||!sameReplace(m.Replace,n.Replace){panic("unapproved graph change: "+p)}}
 expected:=originalMod;for p,w:=range l.Modules{old:=p+" "+l.Original_versions[p];if strings.Count(expected,old)!=1{panic("original version ambiguous")};expected=strings.Replace(expected,old,p+" "+w.Version,1)};if expected!=effectiveMod{panic("unapproved go.mod edit")}
 allowed:=map[string]bool{};for _,s:=range strings.Split(strings.TrimSpace(originalSum),"\n"){allowed[s]=true};for _,w:=range l.Modules{for _,s:=range w.Go_sum_lines{allowed[s]=true}};got:=map[string]bool{};for _,s:=range strings.Split(strings.TrimSpace(effectiveSum),"\n"){if !allowed[s]{panic("unapproved go.sum entry")};got[s]=true};for s:=range allowed{if !got[s]{panic("go.sum entry removed")}}}
const testPath="github.com/xyproto/randomstring"
const testVersion="v1.0.5"
const testSum="h1:YtlWPoRdgMu3NZtP45drfy1GKoojuR7hmRcnhZqKjWU="
const testModSum="h1:rgmS5DeNXLivK7YprL0pY+lTuhNQW3iGxZ18UQApw/E="
func testSumLines()string{return testPath+" "+testVersion+" "+testSum+"\n"+testPath+" "+testVersion+"/go.mod "+testModSum+"\n"}
func existing(ms,before map[string]Module,originalSum string){
 m,ok:=ms[testPath];if len(ms)!=1||!ok||m.Path!=testPath||m.Version!=testVersion||m.Replace!=nil{panic("unapproved test dependency")}
 prior,ok:=before[testPath];if !ok||prior.Version!=testVersion||prior.Replace!=nil{panic("test dependency absent from original graph")}
 for _,line:=range strings.Split(strings.TrimSpace(testSumLines()),"\n"){if strings.Count("\n"+originalSum,"\n"+line+"\n")!=1{panic("test dependency lacks immutable original checksum")}}
 if m.Sum!=testSum||m.GoModSum!=testModSum{panic("test dependency checksum drift")}
 for _,p:=range []string{m.Zip,m.GoMod}{info,e:=os.Stat(p);must(e);if !info.Mode().IsRegular()||info.Size()==0{panic("missing test dependency archive")}}
}
func copyModules(in map[string]Module)map[string]Module{out:=map[string]Module{};for k,v:=range in{out[k]=v};return out}
func rejected(label string,call func()){
 caught:=false;func(){defer func(){if recover()!=nil{caught=true}}();call()}();if !caught{panic("negative control unexpectedly passed: "+label)};fmt.Println("NEGATIVE_CONTROL_PASS",label)
}
func controls(l Input){
 for _,p:=range []string{"-s -w",swProfile+" -X injected",swProfile+"\n"}{rejected("unapproved-linker-profile",func(){linkerFlags(p)})};if linkerFlags(swProfile)!=originalLinkerFlags+" -s -w"{panic("fixed linker flag mismatch")}
 a,b:=modules("/build/before.json"),modules("/build/after.json");targets:=modules("/build/targets.json");test:=modules("/build/existing-test.json")
 om,em,osum,esum:=string(file("/build/original.go.mod")),string(file("/build/source/go.mod")),string(file("/build/original.go.sum")),string(file("/build/source/go.sum"))
 check:=func(next map[string]Module,sum string){graph(l,a,next,om,em,osum,sum)};check(b,esum);downloads(l,targets);existing(test,a,osum)
 rejected("unknown-module",func(){next:=copyModules(b);next["unapproved.invalid/module"]=Module{Path:"unapproved.invalid/module",Version:"v1.0.0"};check(next,esum)})
 rejected("unexpected-checksum",func(){check(b,esum+"unapproved.invalid/module v1.0.0 h1:unapproved\n")})
 rejected("dependency-graph-drift",func(){next:=copyModules(b);m:=next[testPath];m.Version="v1.0.6";next[testPath]=m;check(next,esum)})
 rejected("unexpected-replacement",func(){next:=copyModules(b);m:=next[testPath];m.Replace=&Module{Path:"unapproved.invalid/module",Version:"v1.0.0"};next[testPath]=m;check(next,esum)})
 rejected("unknown-test-download",func(){next:=copyModules(test);m:=next[testPath];delete(next,testPath);m.Path="unapproved.invalid/module";next[m.Path]=m;existing(next,a,osum)})
 rejected("missing-original-test-checksum",func(){existing(test,a,strings.ReplaceAll(osum,testSum,"h1:unapproved"))})
 rejected("original-test-graph-drift",func(){next:=copyModules(a);m:=next[testPath];m.Version="v1.0.6";next[testPath]=m;existing(test,next,osum)})
 rejected("test-checksum-drift",func(){next:=copyModules(test);m:=next[testPath];m.Sum="h1:unapproved";next[testPath]=m;existing(next,a,osum)})
 dir,e:=os.MkdirTemp("/tmp","offline-negative-");must(e);defer os.RemoveAll(dir)
 rejected("missing-dependency-archive",func(){next:=copyModules(test);m:=next[testPath];m.Zip=dir+"/absent.zip";next[testPath]=m;existing(next,a,osum)})
 rejected("missing-security-module-archive",func(){next:=copyModules(targets);m:=next["github.com/go-jose/go-jose/v4"];m.Zip=dir+"/absent.zip";next[m.Path]=m;downloads(l,next)})
 must(os.WriteFile(dir+"/go.mod",[]byte("module offlinecontrol\ngo 1.26.10\nrequire "+testPath+" "+testVersion+"\n"),0600));must(os.WriteFile(dir+"/go.sum",[]byte(testSumLines()),0600));must(os.WriteFile(dir+"/main.go",[]byte("package main\nimport _ \""+testPath+"\"\nfunc main(){}\n"),0600))
 if os.Getenv("GOPROXY")!="https://proxy.golang.org"||os.Getenv("GOSUMDB")!="sum.golang.org"{panic("offline control must retain authenticated official download settings")}
 cmd:=exec.Command("timeout","10","go","build","-mod=readonly","-o",dir+"/program",".");cmd.Dir=dir;cmd.Env=append(os.Environ(),"GOCACHE="+dir+"/cache","GOMODCACHE="+dir+"/modules")
 output,e:=cmd.CombinedOutput();if e==nil||!strings.Contains(string(output),"network is unreachable"){panic("online compilation rejection not demonstrated")};if _,e=os.Stat(dir+"/program");!os.IsNotExist(e){panic("offline control produced executable")}
 fmt.Println("NEGATIVE_CONTROL_PASS","attempted-online-compilation");fmt.Println("ORIGINAL_TEST_DEPENDENCY_VERIFIED",testPath,testVersion,testSum,testModSum)
}
func main(){var l Input;must(json.Unmarshal(file("/build/security-build.lock.json"),&l));switch os.Args[1]{
case "build":build(l,os.Args[2],os.Args[3])
case "source":for _,p:=range []string{"go.mod","go.sum","docker/entrypoint.sh","docker/filer.toml"}{if hash("/build/source/"+p)!=l.Source[p+"_sha256"]{panic("source member mismatch: "+p)}}
case "downloads":downloads(l,modules("/build/targets.json"))
case "existing":existing(modules("/build/existing-test.json"),modules("/build/before.json"),string(file("/build/original.go.sum")))
case "graph":graph(l,modules("/build/before.json"),modules("/build/after.json"),string(file("/build/original.go.mod")),string(file("/build/source/go.mod")),string(file("/build/original.go.sum")),string(file("/build/source/go.sum")))
case "controls":controls(l)
default:panic("unknown verification mode")}}
GO
  GOCACHE=/tmp/bootstrap-cache go build -trimpath -buildvcs=false -o /build/check /build/check.go
  rm -rf /tmp/bootstrap-cache
  ;;
prepare)
  # HTTPS only, no caller-selected origin, bounded transfer, checksum before tar.
  curl --proto '=https' --proto-redir '=https' --max-redirs 3 --fail --location \
    --connect-timeout 15 --max-time 180 --retry 2 --retry-max-time 360 \
    'https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/ffa87c25fdf587178b1521ad87f2a4a72a02e584' \
    -o /build/source.tar.gz
  echo 'd650e7a8a2cbec8a1725386f87f5eb803c95aa84417530aec58c1925fd23a2c9  /build/source.tar.gz' | sha256sum -c -
  mkdir /build/source
  tar -xzf /build/source.tar.gz -C /build/source --strip-components=1
  /build/check source
  cd /build/source
  cp go.mod /build/original.go.mod
  cp go.sum /build/original.go.sum
  go list -mod=readonly -m -json all > /build/before.json
  go mod edit -require=github.com/go-jose/go-jose/v4@v4.1.6
  go mod edit -require=github.com/andybalholm/brotli@v1.2.7
  go mod download -json github.com/go-jose/go-jose/v4@v4.1.6 github.com/andybalholm/brotli@v1.2.7 > /build/targets.json
  /build/check downloads
  go mod download
  # This upstream Brotli test dependency already has both immutable checksum
  # records in the original SeaweedFS go.sum. Fetch it without enumerating
  # unused modules or broadening the original-plus-four checksum set.
  go mod download -json github.com/xyproto/randomstring@v1.0.5 > /build/existing-test.json
  /build/check existing
  go list -mod=readonly -m -json all > /build/after.json
  /build/check graph
  go mod verify
  rm /build/source.tar.gz
  ;;
compile)
  cd /build/source
  /build/check controls
  /build/check graph
  go mod verify
  mkdir -p /out/provenance /tmp/cache-one /tmp/cache-two
  for pair in 'one /out/weed' 'two /out/weed'; do
    set -- $pair
    GOCACHE="/tmp/cache-$1" /build/check build "$1" "$2"
    if [ "$1" = one ]; then cp /out/weed /out/weed.second; fi
  done
  cmp /out/weed /out/weed.second
  sha256sum /out/weed /out/weed.second > /out/provenance/elf-sha256.txt
  cat /out/provenance/elf-sha256.txt
  go version -m /out/weed > /out/provenance/go-version-m.txt
  cat /out/provenance/go-version-m.txt
  grep -F 'go1.26.10' /out/provenance/go-version-m.txt
  grep -F 'github.com/go-jose/go-jose/v4' /out/provenance/go-version-m.txt | grep -F 'v4.1.6'
  grep -F 'github.com/andybalholm/brotli' /out/provenance/go-version-m.txt | grep -F 'v1.2.7'
  cp /build/security-build.lock.json /out/provenance/
  cp go.mod go.sum /out/provenance/
  cp /build/after.json /out/provenance/module-graph.json
  cp LICENSE /out/provenance/LICENSE.seaweedfs.txt
  cp /usr/local/go/LICENSE /out/provenance/LICENSE.go.txt
  cp /root/go/pkg/mod/github.com/go-jose/go-jose/v4@v4.1.6/LICENSE /out/provenance/LICENSE.go-jose.txt
  cp /root/go/pkg/mod/github.com/andybalholm/brotli@v1.2.7/LICENSE /out/provenance/LICENSE.go-brotli.txt
  # These upstream test executables run later in independent resource-limited
  # containers. Their compilation is covered by this network-disabled RUN.
  GOCACHE=/tmp/cache-one go test -mod=readonly -p=2 -c -o /out/jose.test github.com/go-jose/go-jose/v4
  GOCACHE=/tmp/cache-one go test -mod=readonly -p=2 -c -o /out/brotli.test github.com/andybalholm/brotli
  cat > /build/security-probe.go <<'GO'
package main
import("bytes";"crypto/rand";"crypto/rsa";"encoding/base64";"encoding/json";"fmt";"io";"os";jose "github.com/go-jose/go-jose/v4";"github.com/andybalholm/brotli")
func must(e error){if e!=nil{panic(e)}}
func main(){if jose.MaxRSAModulusBits!=4096{panic("default RSA limit changed")};switch os.Args[1]{case "rsa":
 for _,bits:=range []int{2048,4096}{k,e:=rsa.GenerateKey(rand.Reader,bits);must(e);raw,e:=json.Marshal(jose.JSONWebKey{Key:&k.PublicKey});must(e);var parsed jose.JSONWebKey;must(json.Unmarshal(raw,&parsed));if !parsed.Valid(){panic("supported RSA JWK rejected")};s,e:=jose.NewSigner(jose.SigningKey{Algorithm:jose.RS256,Key:k},nil);must(e);sig,e:=s.Sign([]byte("public synthetic compatibility control"));must(e);v,e:=sig.Verify(&k.PublicKey);must(e);if string(v)!="public synthetic compatibility control"{panic("signature mismatch")}}
case "jwk":
 n:=base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{255},1024));var key jose.JSONWebKey
 if json.Unmarshal([]byte(`{"kty":"RSA","n":"`+n+`","e":"AQAB"}`),&key)==nil{panic("oversized RSA key accepted")}
 k,e:=rsa.GenerateKey(rand.Reader,2048);must(e)
 for _,private:=range []bool{false,true}{var material interface{}=&k.PublicKey;if private{material=k};jwk,e:=json.Marshal(jose.JSONWebKey{Key:material});must(e);header,e:=json.Marshal(map[string]interface{}{"alg":"RS256","jwk":json.RawMessage(jwk)});must(e);msg:=base64.RawURLEncoding.EncodeToString(header)+".eA.eA";_,e=jose.ParseSigned(msg,[]jose.SignatureAlgorithm{jose.RS256});if private&&e==nil{panic("private header accepted")};if !private{must(e)}}
case "brotli":var b bytes.Buffer;w:=brotli.NewWriter(&b);_,e:=w.Write([]byte("synthetic round trip"));must(e);must(w.Close());v,e:=io.ReadAll(io.LimitReader(brotli.NewReader(&b),1048576));must(e);if string(v)!="synthetic round trip"{panic("roundtrip mismatch")};_,e=io.ReadAll(io.LimitReader(brotli.NewReader(bytes.NewReader(bytes.Repeat([]byte{255},64))),1048576));if e==nil{panic("malformed brotli accepted")}
default:panic("unknown probe")};fmt.Println("PASS",os.Args[1])}
GO
  GOCACHE=/tmp/cache-one go build -mod=readonly -p=2 -trimpath -buildvcs=false -o /out/security-probe /build/security-probe.go
  /build/check graph
  cat /out/provenance/elf-sha256.txt
  rm -rf /tmp/cache-one /tmp/cache-two
  rm /out/weed.second
  ;;
*) echo 'usage: build-weed.sh bootstrap|prepare|compile' >&2; exit 2 ;;
esac
