def tld_of(domain: str) -> str:
    """Last label with a leading dot: '.com' for 'a.b.com'.

    Multi-part suffixes (co.uk) yield '.uk', which is what TLD policy means here.
    """
    domain = domain.strip(".").lower()
    return "." + domain.rsplit(".", 1)[-1] if "." in domain else ""


# Clean a user-entered list of TLDs into a set of '.xyz' style strings.
def normalize_tlds(values) -> set:
    return {"." + v.strip().lower().lstrip(".") for v in values if v and v.strip()}
