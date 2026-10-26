"""Build src/lib/mi-hospitals.json from the CMS Hospital General Information dataset (xubh-q36u).
Run yearly: python3 scripts/build-mi-hospitals.py [path/to/Hospital_General_Information.csv]"""
import csv, json, re, sys, urllib.request

URL = ("https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0"
       "?conditions%5B0%5D%5Bproperty%5D=state&conditions%5B0%5D%5Bvalue%5D=MI&limit=1000")
SMALL = {"of", "and", "the", "at", "in", "for"}
KEEP = {"UP", "UM", "DMC", "VA", "ER", "II"}


def tc(s: str) -> str:
    out = []
    for i, w in enumerate(s.split()):
        if w in KEEP:
            out.append(w)
        elif i and w.lower() in SMALL:
            out.append(w.lower())
        else:
            out.append(re.sub(r"^(Mc)(\w)", lambda m: m.group(1) + m.group(2).upper(), w.capitalize()))
    return " ".join(out).replace("'S", "'s")


if len(sys.argv) > 1:
    with open(sys.argv[1], encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        required = {"Facility ID", "Facility Name", "City/Town", "State", "County/Parish", "Hospital Type"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("The CMS hospital CSV is missing required columns")
        mi = [r for r in reader if r["State"].strip() == "MI"]
    if not mi or len({r["Facility ID"] for r in mi}) != len(mi):
        raise ValueError("The Michigan hospital rows are empty or have duplicate facility IDs")
    rows = [{"facility_name": r["Facility Name"], "citytown": r["City/Town"],
             "countyparish": r["County/Parish"], "hospital_type": r["Hospital Type"]} for r in mi]
else:
    rows = json.load(urllib.request.urlopen(URL))["results"]
if any(not r[k].strip() for r in rows for k in ("facility_name", "citytown", "countyparish", "hospital_type")):
    raise ValueError("A hospital row is missing its name, city, county, or type")
hosp = sorted(
    ({"name": tc(r["facility_name"]), "city": tc(r["citytown"]), "county": tc(r["countyparish"]), "type": r["hospital_type"]} for r in rows),
    key=lambda h: h["name"],
)
json.dump(hosp, open("src/lib/mi-hospitals.json", "w"), separators=(",", ":"))
print(len(hosp), "hospitals")
