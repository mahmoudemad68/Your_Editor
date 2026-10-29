#!/bin/sh
# Inspect archive bytes and the actual ELF without executing the candidate.
# Caller must additionally establish Supply/PR policy for CI admission.
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
work="${2:?private evidence directory required}"
mkdir -p "$work"
chmod 700 "$work"
case "${1:?image ID or archive required}" in
  sha256:*) docker image save --platform linux/amd64 "$1" -o "$work/candidate.tar"; archive="$work/candidate.tar" ;;
  *) archive="$1" ;;
esac
donor='chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8'
compiler='golang:1.26.10-alpine3.24@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308'
docker image inspect "$donor" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$donor" >&2
donor_id="$(docker image inspect "$donor" --format '{{.Id}}')"
docker image save --platform linux/amd64 "$donor_id" -o "$work/donor.tar"
python3 - "$archive" "$work" "$root" <<'PY'
import hashlib,json,sys,tarfile,posixpath,gzip
from pathlib import Path
archive,work,root=map(Path,sys.argv[1:])
lock=json.loads((root/'infra/seaweedfs/security-build.lock.json').read_text())
sha=lambda b:hashlib.sha256(b).hexdigest()
def path(s):
    s=s.removeprefix('./').rstrip('/')
    if s in ('','.'): return ''
    if s.startswith('/') or '\\' in s or any(p in ('','..') for p in s.split('/')): raise ValueError('unsafe image path')
    return s
def image(file,candidate):
    files={}; content={}; total=0; count=0; expanded_all=0; elf_hashes=set()
    with tarfile.open(file,'r:') as outer:
        members=outer.getmembers(); names=[path(m.name) for m in members]
        if len(names)!=len(set(names)) or len(names)>20000: raise ValueError('duplicate/excess outer paths')
        if any(m.issym() or m.islnk() or not(m.isfile() or m.isdir()) for m in members): raise ValueError('unsafe outer member')
        def metadata(name):
            info=outer.getmember(name)
            if info.size>1048576: raise ValueError('oversized image metadata')
            return json.load(outer.extractfile(info))
        manifest=metadata('manifest.json')
        if len(manifest)!=1: raise ValueError('ambiguous image manifest')
        m=manifest[0]; config_bytes=outer.extractfile(path(m['Config'])).read(1048577)
        if len(config_bytes)>1048576: raise ValueError('oversized config')
        config=json.loads(config_bytes)
        if config.get('architecture')!='amd64' or config.get('os')!='linux': raise ValueError('unsupported platform')
        if 'index.json' in names:
            # Containerd-backed Docker saves also contain OCI metadata. Validate
            # that it describes this SAME single image; never load an unchecked
            # alternative image via a second manifest interpretation.
            layout=metadata('oci-layout')
            if layout.get('imageLayoutVersion')!='1.0.0': raise ValueError('unsupported OCI layout')
            leaves=[]
            def descriptor(d,depth=0):
                if depth>4 or not isinstance(d.get('digest'),str) or not d['digest'].startswith('sha256:'): raise ValueError('invalid OCI descriptor')
                name='blobs/sha256/'+d['digest'][7:]
                info=outer.getmember(name)
                if info.size!=d['size']: raise ValueError('OCI size mismatch')
                stream=outer.extractfile(info);h=hashlib.sha256()
                while chunk:=stream.read(1048576): h.update(chunk)
                if 'sha256:'+h.hexdigest()!=d['digest']: raise ValueError('OCI blob mismatch')
                if 'index' in d['mediaType'] or 'manifest.list' in d['mediaType']:
                    value=metadata(name)
                    if len(value.get('manifests',[]))!=1: raise ValueError('ambiguous OCI image index')
                    descriptor(value['manifests'][0],depth+1)
                elif 'manifest' in d['mediaType']:
                    value=metadata(name);leaves.append(value)
                else: raise ValueError('unsupported OCI image descriptor')
            index=metadata('index.json')
            if len(index.get('manifests',[]))!=1: raise ValueError('ambiguous OCI root')
            descriptor(index['manifests'][0])
            if len(leaves)!=1 or leaves[0]['config']['digest']!='sha256:'+sha(config_bytes) or leaves[0]['config']['size']!=len(config_bytes): raise ValueError('OCI/legacy image identity conflict')
            descriptors=leaves[0]['layers']
            if len(descriptors)!=len(m['Layers']): raise ValueError('OCI layer count mismatch')
            for entry,legacy in zip(descriptors,m['Layers']):
                if path(legacy)!='blobs/sha256/'+entry['digest'].removeprefix('sha256:') or outer.getmember(path(legacy)).size!=entry['size']: raise ValueError('OCI layer identity conflict')
        diffids=config['rootfs']['diff_ids']
        if len(diffids)!=len(m['Layers']) or not diffids or len(diffids)>64: raise ValueError('missing/excess layers')
        for layer,diffid in zip(m['Layers'],diffids):
            layer=path(layer)
            if layer.startswith('blobs/sha256/'):
                raw=outer.extractfile(layer);h=hashlib.sha256()
                while chunk:=raw.read(1048576): h.update(chunk)
                if h.hexdigest()!=layer.rsplit('/',1)[1]: raise ValueError('compressed blob digest mismatch')
            def layer_stream():
                stream=outer.extractfile(layer)
                # OCI blobs may remain gzip encoded in Docker's save format.
                if stream.read(2)==b'\x1f\x8b': return gzip.GzipFile(fileobj=outer.extractfile(layer))
                return outer.extractfile(layer)
            stream=layer_stream(); h=hashlib.sha256()
            while chunk:=stream.read(1048576):
                expanded_all+=len(chunk)
                if expanded_all>4*1024**3: raise ValueError('layer expansion limit')
                h.update(chunk)
            # The image config binds UNCOMPRESSED layer tar digests.
            if 'sha256:'+h.hexdigest()!=diffid: raise ValueError('layer digest mismatch')
            with tarfile.open(fileobj=layer_stream(),mode='r|') as inner:
                seen=set()
                for entry in inner:
                    name=path(entry.name)
                    if not name: continue
                    count+=1; total+=entry.size
                    if count>200000 or total>4*1024**3 or entry.size>512*1024**2: raise ValueError('image expansion limit')
                    if name in seen: raise ValueError('duplicate layer path')
                    seen.add(name)
                    parent,base=posixpath.split(name)
                    if base.startswith('.wh.'):
                        if candidate: raise ValueError('whiteout in clean runtime')
                        victim=posixpath.join(parent,base[4:])
                        for key in list(files):
                            if (base=='.wh..wh..opq' and (not parent or key.startswith(parent+'/'))) or key==victim or key.startswith(victim+'/'): files.pop(key);content.pop(key,None)
                        continue
                    if entry.issym() or entry.islnk():
                        target=posixpath.normpath(posixpath.join(parent,entry.linkname)) if entry.issym() else posixpath.normpath(entry.linkname)
                        if target.startswith('../') or (candidate and name.startswith('usr/share/editagent-seaweedfs/')): raise ValueError('unsafe link')
                    if candidate and (name=='usr/local/go' or name.startswith('usr/local/go/') or name.startswith('root/go/') or name.startswith('build/')): raise ValueError('compiler/source/cache in runtime')
                    digest=None
                    if entry.isfile():
                        f=inner.extractfile(entry); h=hashlib.sha256(); saved=bytearray(); first=b''
                        capture=name in ('usr/bin/weed','lib/apk/db/installed') or name.startswith('usr/share/editagent-seaweedfs/')
                        while chunk:=f.read(1048576):
                            if not first: first=chunk[:4]
                            h.update(chunk)
                            if capture: saved.extend(chunk)
                        digest=h.hexdigest()
                        if first==b'\x7fELF':
                            if candidate and name.startswith('usr/share/editagent-seaweedfs/'): raise ValueError('ELF hidden as provenance')
                            elf_hashes.add(digest)
                        if capture: content[name]=bytes(saved)
                    files[name]=(entry.type.decode('latin1'),entry.mode,entry.uid,entry.gid,entry.linkname,digest)
        return files,content,config,'sha256:'+sha(config_bytes),elf_hashes
base,bc,basecfg,_,_=image(work/'donor.tar',False)
files,data,cfg,image_id,elfs=image(archive,True)
old=sha(bc['usr/bin/weed']); new=sha(data['usr/bin/weed'])
if old==new or old in elfs: raise ValueError('old vulnerable ELF retained')
for name in ['usr/bin/weed','usr/local/bin/editagent-entrypoint.sh']:
    if files[name][1:4]!=(0o755,0,0): raise ValueError('executable owner/mode mismatch')
allowed={'usr/bin/weed','usr/local/bin/editagent-entrypoint.sh','usr/share/editagent-seaweedfs','usr/share/editagent-seaweedfs/security-build.lock.json','usr/share/editagent-seaweedfs/go.mod','usr/share/editagent-seaweedfs/go.sum','usr/share/editagent-seaweedfs/module-graph.json','usr/share/editagent-seaweedfs/go-version-m.txt','usr/share/editagent-seaweedfs/elf-sha256.txt'}
allowed.update('usr/share/editagent-seaweedfs/build-'+label+'.json' for label in ['one','two'])
allowed.update('usr/share/editagent-seaweedfs/LICENSE.'+name+'.txt' for name in ['seaweedfs','go','go-jose','go-brotli'])
generated={'etc/hostname','etc/hosts','etc/resolv.conf'}
for name in set(base)|set(files):
    if name in allowed or name in generated: continue
    if base.get(name)!=files.get(name): raise ValueError('runtime file/owner/mode/link drift: '+name)
for name in allowed-{'usr/share/editagent-seaweedfs'}:
    if name not in files: raise ValueError('missing required runtime file: '+name)
wrapper=(root/'infra/seaweedfs/docker-entrypoint.sh').read_bytes().replace(b'\r\n',b'\n')
if files['usr/local/bin/editagent-entrypoint.sh'][-1]!=sha(wrapper): raise ValueError('firewall wrapper mismatch')
prefix='usr/share/editagent-seaweedfs/'
if json.loads(data[prefix+'security-build.lock.json'])!=lock: raise ValueError('build lock mismatch')
original_mod=data[prefix+'go.mod'].decode()
for name,entry in lock['modules'].items():
    current=name+' '+entry['version']
    if original_mod.count(current)!=1: raise ValueError('invalid effective module file')
    original_mod=original_mod.replace(current,name+' '+lock['original_versions'][name],1)
if sha(original_mod.encode())!=lock['source']['go.mod_sha256']: raise ValueError('unapproved module graph declaration')
new_sums={line for entry in lock['modules'].values() for line in entry['go_sum_lines']}
sum_lines=data[prefix+'go.sum'].decode().splitlines()
if not new_sums.issubset(set(sum_lines)): raise ValueError('missing authenticated module checksums')
original_sum='\n'.join(line for line in sum_lines if line not in new_sums)+'\n'
if sha(original_sum.encode())!=lock['source']['go.sum_sha256']: raise ValueError('unapproved checksum graph')
for label in ['one','two']:
    measurement=json.loads(data[prefix+'build-'+label+'.json'])
    if measurement.get('elf_sha256')!=new or measurement.get('cache_initially_empty') is not True or measurement.get('wall_seconds',0)<=0: raise ValueError('build measurement mismatch')
records=data[prefix+'elf-sha256.txt'].decode().splitlines()
if len(records)!=2 or any(line.split()[0]!=new for line in records): raise ValueError('reproducibility evidence mismatch')
for package in data['lib/apk/db/installed'].decode().split('\n\n'):
    if '\nP:brotli-libs\n' in '\n'+package+'\n':
        if '\nV:1.2.1-r0\n' not in '\n'+package+'\n': raise ValueError('native Brotli mismatch')
        break
else: raise ValueError('native Brotli absent')
for key in ('Cmd','WorkingDir','Volumes','ExposedPorts','User','Env'):
    if cfg['config'].get(key)!=basecfg['config'].get(key): raise ValueError('runtime config drift: '+key)
if cfg['config'].get('Entrypoint')!=['/usr/local/bin/editagent-entrypoint.sh']: raise ValueError('entrypoint drift')
if cfg['config'].get('Labels',{}).get('org.opencontainers.image.version')!='4.51-editagent-sec1': raise ValueError('custom image identity missing')
(work/'weed').write_bytes(data['usr/bin/weed'])
(work/'verify-image.json').write_text(json.dumps({'image_id':image_id,'elf_sha256':new,'old_elf_absent':True,'runtime_preserved':True,'native_brotli':'1.2.1-r0','rust_sha256':{n:files[n][-1] for n in ['usr/bin/weed-volume','usr/bin/weed-worker']},'lock_sha256':sha((root/'infra/seaweedfs/security-build.lock.json').read_bytes()),'reproducible_elf':True,'build_measurements':{label:json.loads(data[prefix+'build-'+label+'.json']) for label in ['one','two']},'project_revision':cfg['config'].get('Labels',{}).get('org.opencontainers.image.revision'),'project_source':cfg['config'].get('Labels',{}).get('org.opencontainers.image.source')},indent=2)+'\n')
(work/'claimed-go-version-m.txt').write_bytes(data[prefix+'go-version-m.txt'])
PY
probe_name="editagent-seaweed-metadata-$$"
trap 'docker rm -f "$probe_name" >/dev/null 2>&1 || true' EXIT
timeout 120 docker run --rm --name "$probe_name" --platform linux/amd64 --network none --read-only --cpus 1 --memory 512m --memory-swap 512m --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" -e GOTOOLCHAIN=local -e HOME=/tmp \
  -v "$(cd "$work" && pwd):/evidence:ro" --entrypoint /usr/local/go/bin/go "$compiler" \
  version -m /evidence/weed > "$work/actual-go-version-m.txt"
python3 - "$work" "$root" <<'PY'
import json,sys
from pathlib import Path
p,root=map(Path,sys.argv[1:]); actual=(p/'actual-go-version-m.txt').read_text(); claimed=(p/'claimed-go-version-m.txt').read_text()
if actual.splitlines()[0].split(': ',1)[1]!=claimed.splitlines()[0].split(': ',1)[1] or actual.splitlines()[1:]!=claimed.splitlines()[1:]: raise ValueError('actual ELF metadata differs')
if not actual.splitlines()[0].endswith('go1.26.10'): raise ValueError('compiler mismatch')
modules={}
for line in actual.splitlines()[1:]:
    parts=line.split()
    if parts and parts[0]=='dep': modules[parts[1]]=parts[2:]
for name,entry in json.loads((root/'infra/seaweedfs/security-build.lock.json').read_text())['modules'].items():
    if modules.get(name)!=[entry['version'],entry['go_sum_lines'][0].split()[2]]: raise ValueError('linked module mismatch')
for setting in ['CGO_ENABLED=0','GOARCH=amd64','GOAMD64=v1','GOOS=linux','-trimpath=true']:
    if setting not in actual: raise ValueError('native build settings missing')
print('IMAGE_AND_ACTUAL_ELF_VERIFIED')
PY
