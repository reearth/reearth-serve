"""Range-read 7z start header + tail into a sparse file, parse folders with py7zr. usage: venv/bin/python sevenz_probe.py urls.txt out.jsonl workdir"""
import sys,os,json,struct,urllib.request,concurrent.futures as cf,tempfile,py7zr
def rng(u,h):
    r=urllib.request.urlopen(urllib.request.Request(u,headers={'Range':h,'User-Agent':'archive-survey/1'}),timeout=40); return r.read(),r.headers.get('Content-Range')
def one(a):
    for back in (1<<18,1<<23,1<<26):
        r=one1(a,back)
        if 'err' not in r or back==(1<<26) or r['err'].startswith('bad sig') or 'Timeout' in r['err'] or 'timed out' in r['err']: r['tail_read']=back; return r
    return r
def one1(a,back):
    u,wd=a
    try:
        head,cr=rng(u,'bytes=0-31'); size=int(cr.split('/')[1])
        if head[:6]!=b"7z\xbc\xaf\x27\x1c": return {'url':u,'err':'bad sig'}
        nho,nhs=struct.unpack('<QQ',head[12:28]); nhstart=32+nho
        tail,_=rng(u,f'bytes={max(32,nhstart-back)}-{size-1}') # packed encoded header sits just before next header
        base=max(32,nhstart-back)
        p=os.path.join(wd,os.path.basename(u)+'.sparse')
        with open(p,'wb') as f:
            f.truncate(size); f.write(head); f.seek(base); f.write(tail)
        with py7zr.SevenZipFile(p,'r') as z:
            ai=z.archiveinfo()
            folders=z.header.main_streams.unpackinfo.folders if z.header.main_streams else []
            subs=z.header.main_streams.substreamsinfo.num_unpackstreams_folders if z.header.main_streams and z.header.main_streams.substreamsinfo else []
            files=len(z.files)
            codecs=sorted({str(c.get('method')) for fo in folders for c in fo.coders})
            enc=any(c.get('method')==b'\x06\xf1\x07\x01' for fo in folders for c in fo.coders)
            r={'url':u,'size':size,'solid':bool(ai.solid),'folders':len(folders),'unpack_streams_per_folder':subs[:8],'multi_stream_folders':sum(x>1 for x in subs),'streams_total':sum(subs),'streams_in_multi_folders':sum(x for x in subs if x>1),'max_folder_unpack_bytes':max((fo.unpacksizes[-1] if fo.unpacksizes else 0) for fo in folders) if folders else 0,'max_streams_in_folder':max(subs) if subs else 0,'files':files,'codecs':codecs,'header_bytes':nhs,'header_encoded_ok':True}
        os.remove(p); return r
    except Exception as e:
        return {'url':u,'err':repr(e)[:200]}
if __name__=='__main__':
    urls=[l.strip() for l in open(sys.argv[1]) if l.strip()]
    wd=sys.argv[3]; os.makedirs(wd,exist_ok=True)
    with cf.ThreadPoolExecutor(6) as ex, open(sys.argv[2],'w') as f:
        for fu in cf.as_completed([ex.submit(one,(u,wd)) for u in urls]):
            r=fu.result(); f.write(json.dumps(r)+'\n'); f.flush()
