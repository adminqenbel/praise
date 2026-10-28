"""Algorithmically generated / random-looking domain labels.

Real names are pronounceable: letters follow each other the way they do in English and brand names. Generated
names (DGAs, throwaway kits) are not. We train a character-bigram model at import time from an embedded word
list and combine three cheap features into one 0..1 "randomness" score:

* average bigram log-likelihood (how English-like the letter pairs are),
* the longest run of consonants,
* the share of digits mixed in with letters.

Short labels (< 7 characters) are never scored: too little evidence and too many genuine acronyms.
"""
import math
from collections import Counter
from functools import lru_cache

from .data import BRAND_TOKENS, TERMS

_VOWELS = frozenset("aeiouy")

# Training text: common English and web vocabulary, product and place words. Only letter-pair statistics
# are learned, so this does not need to be large or exact.
_WORDS = """
about above account action active actually address advice after again against agent allow almost along
already always amazing america american among amount animal another answer anyone anything apple april
around article artist asked august author available away baby back balance bank base basic beach beautiful
because become before begin behind believe benefit best better between beyond bill birthday black blog blue
board body book border bottom brand break bridge bright bring broad brother brown build business button
call camera campus capital card care career carry case catalog center central century certain chair challenge
change channel chapter charge chart cheap check child choice choose church circle city class clean clear
click climate clock close cloud club coach coast code coffee cold college color come common community company
compare complete computer concept condition connect contact content contest control cook cool copy corner
cost could country course court cover create credit crowd culture current custom daily dance data date
daughter dealer death debate decide deep degree delivery design detail develop device digital dinner direct
doctor dollar domain door double down draft dream drive early earth east easy economy edge editor education
effect eight either electric email empire energy engine enjoy enough enter entire episode equal escape
estate even evening event ever every exact example expert explore express extra face fact factory fair
faith family famous farm fashion fast father favorite feature feel field fight figure file fill film final
finance find fine finish fire first fish fitness five flash flight floor flower focus follow food foot force
forest form forward found four free fresh friend from front fruit full fund future gallery game garden
gather general gift girl give glass global goal gold good government grade grand great green group grow
guide guitar hair half hand happy hard head health hear heart heavy help here high history hold holiday home
honest hope horse hospital hotel hour house however human hundred idea image impact important improve include
income index india indian industry info inside instant interest internet invest island issue item jewelry job
join journal journey judge juice jump just keep key kids kind king kitchen knowledge label lake land language
large laser last later laugh launch law lawyer lead learn least leave legal less letter level library life
light like limit line link list listen little live local lock long look love lower luck lunch machine magazine
mail main make manage many map marathon market master match material matter maybe meal media medical meet
member memory mental menu message metal method middle might military million mind minute mirror mobile model
modern moment money month moon more morning most mother motion mountain movie music name nation native nature
near need network never news next nice night noble north note nothing notice number nurse object ocean offer
office official often older once online only open option orange order organic origin other outdoor outside
owner pack page paint paper parent park part party pass past path patient pause payment peace people perfect
period person phone photo physical piano pick picture piece pilot pizza place plan plant platform play player
please point police policy pool popular portal position positive possible post power practice present press
pretty price pride prime print private prize problem process product profile program project promise property
protect provide public pure quality question quick quiet race radio rain range rapid rate rather reach read
ready real reason recent record red region relax remember report research resource response rest result return
review reward rich right ring rise river road rock room round route royal rule run safe sale same sample save
school science score screen sea search season second secret section secure see seed sell send senior sense
series serious serve service set seven several shape share sharp shop short should show side sign silver
simple since single site six size skill sleep slow small smart smile social soft software solar solid solution
some sound source south space speak special speed spirit sport spring square staff stage standard star start
state station stay steel step still stock stone stop store story straight strange street strong student studio
study style subject success such summer sun super supply support sure surface sweet swim system table take
talk target taste teach team tech technology tell ten tennis term test text thank theater theme there thing
think third thought three through time tiny title today together tonight tool top total touch tour tower town
toy track trade traffic train travel tree trend trial trip true trust truth try turn twin type under union
unique unit until update upper urban usage use useful user usual vacation valley value variety various vast
vehicle venture version very video view village vintage virtual vision visit voice volume wait walk wall want
warm watch water wave way wealth weather web week weight welcome well west whale what wheel when where which
while white whole wide wife will wind window wine winter wish with within without woman wonder wood word work
world worth would write yard year yellow yesterday young youth zone zero zebra yoga xenon xylophone knight
night right light thought brought strength length string spring squirrel schedule christmas sixth twelfth
facebook google youtube amazon twitter instagram linkedin netflix microsoft wikipedia github stackoverflow
reddit pinterest tumblr wordpress blogspot cloudflare dropbox spotify whatsapp telegram flipkart paytm
hdfcbank icicibank axisbank kotak zerodha phonepe razorpay binance coinbase paypal barclays chase
nvidia samsung huawei xiaomi logitech baidu alibaba tencent yandex
nytimes bbc cnn guardian forbes bloomberg wsj techcrunch engadget nginx kubernetes docker python
javascript typescript mozilla firefox chrome android ubuntu debian fedora mysql postgres mongodb redis
stripe shopify wix squarespace godaddy namecheap bluehost hostgator digitalocean heroku vercel netlify
""".split()


def _train():
    pairs, firsts = Counter(), Counter()
    vocab = set(_WORDS) | set(BRAND_TOKENS) | set(TERMS)
    for w in vocab:
        w = "^" + "".join(c for c in w if c.isalpha()) + "$"
        for a, b in zip(w, w[1:]):
            pairs[(a, b)] += 1
            firsts[a] += 1
    return pairs, firsts


_PAIRS, _FIRSTS = _train()
_ALPHABET = 28   # 26 letters + boundaries (for add-one smoothing)


def _pair_logp(a: str, b: str) -> float:
    return math.log((_PAIRS.get((a, b), 0) + 0.5) / (_FIRSTS.get(a, 0) + 0.5 * _ALPHABET))


def _longest_consonant_run(s: str) -> int:
    best = run = 0
    for c in s:
        if c.isalpha() and c not in _VOWELS:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best


@lru_cache(maxsize=16384)
def randomness(label: str) -> tuple[float, dict]:
    """(score 0..1, features) for one label (the registrable label, hyphens/digits kept). 0 = natural name."""
    letters = "".join(c for c in label if c.isalpha())
    n_alnum = sum(1 for c in label if c.isalnum())
    feats = {"len": float(n_alnum)}
    if n_alnum < 7 or len(letters) < 4 or not letters.isascii():
        return 0.0, feats

    # Split on hyphens/digits so "shop-4u-today" is judged word by word, then average over the pairs.
    chunks = [c for c in "".join(ch if ch.isalpha() else " " for ch in label).split() if len(c) >= 2]
    total, count = 0.0, 0
    for chunk in chunks:
        w = "^" + chunk + "$"
        for a, b in zip(w, w[1:]):
            total += _pair_logp(a, b)
            count += 1
    avg_ll = total / count if count else 0.0
    run = _longest_consonant_run(label)
    digit_share = sum(c.isdigit() for c in label) / n_alnum
    vowel_share = sum(c in _VOWELS for c in letters) / len(letters)
    feats.update(avg_ll=round(avg_ll, 3), consonant_run=float(run), digit_share=round(digit_share, 3),
                 vowel_share=round(vowel_share, 3))

    # Each feature maps to 0..1 with a soft ramp; the score is a weighted sum so no single odd feature
    # (a genuine acronym like "sbcglobal" has a long consonant run) can decide alone.
    ll_part = _ramp(avg_ll, -3.2, -4.6)                   # natural names sit around -2.3..-3.0
    run_part = _ramp(run, 3.5, 6)
    digit_part = _ramp(digit_share, 0.15, 0.45) if digit_share < 0.8 and len(letters) >= 3 else 0.0
    vowel_part = max(_ramp(vowel_share, 0.22, 0.08), _ramp(vowel_share, 0.62, 0.8))
    word_score = 0.50 * ll_part + 0.20 * run_part + 0.15 * digit_part + 0.15 * vowel_part
    # Letters and digits interleaved ("a8f3k2j9d0s1") leave no letter pairs to judge but are the clearest sign.
    flips = sum(1 for a, b in zip(label, label[1:]) if a.isdigit() != b.isdigit() and a.isalnum() and b.isalnum())
    flip_share = flips / max(1, n_alnum - 1)
    feats["digit_flips"] = round(flip_share, 3)
    soup_score = _ramp(flip_share, 0.2, 0.55) * _ramp(digit_share, 0.12, 0.3) * 0.9
    score = max(word_score, soup_score)
    feats["randomness"] = round(score, 3)
    return min(1.0, score), feats


def _ramp(x: float, lo: float, hi: float) -> float:
    """0 at `lo`, 1 at `hi`, linear in between (works for either direction)."""
    t = (x - lo) / (hi - lo)
    return 0.0 if t <= 0 else 1.0 if t >= 1 else t
