import json,urllib.request,concurrent.futures as cf,sys
names=json.load(open('out/plateau_names.json'))
def get(n):
    for _ in range(3):
        try:
            return json.load(urllib.request.urlopen('https://www.geospatial.jp/ckan/api/3/action/package_show?id='+n,timeout=40))['result']
        except Exception as e: err=e
    return None
out=[]
with cf.ThreadPoolExecutor(8) as ex:
    for p in ex.map(get,names):
        if p: out.append({'name':p['name'],'res':[{'n':r.get('name'),'u':r.get('url'),'f':r.get('format'),'s':r.get('size')} for r in p['resources']]})
json.dump(out,open('out/resources.json','w'))
print(len(out))
