import re,random,urllib.request
random.seed(18)
def get(u): return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'archive-survey/1'}),timeout=40).read().decode()
urls=[]
for w,d in (('enwiki','20261101'),('dewiki','20261101'),('frwiki','20261101'),('jawiki','20261101')):
    try:
        f=re.findall(r'href="(/[^"]*\.7z)"',get(f'https://dumps.wikimedia.org/{w}/{d}/')); random.shuffle(f); urls+=['https://dumps.wikimedia.org'+x for x in f[:8]]
    except Exception as e: print(w,e)
open('out/other_7z_urls.txt','w').write('\n'.join(urls)); print(len(urls))
