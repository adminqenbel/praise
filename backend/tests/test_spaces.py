"""One login, two spaces: a family space and a personal (Praise Shield) space on the same email."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from services import ai_service
from tests.test_adult import adult
from tests.test_models import app  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def isolate():
    yield
    ai_service.set_classifier(None)


def family(app, email="both@x.com"):
    c = app.test_client()
    r = c.post("/api/auth/register", json={"email": email, "password": "password123"})
    assert r.status_code == 201
    return c, {"X-CSRF-Token": r.get_json()["csrf"]}


def me(c):
    return c.get("/api/auth/me").get_json()["user"]


def switch(c, h, space, enable=None):
    body = {"space": space} | ({"enable": enable} if enable is not None else {})
    return c.post("/api/auth/space", json=body, headers=h)


def code_for(c, h, child_id):
    return c.post(f"/api/children/{child_id}/devices", json={"label": "Laptop"}, headers=h).get_json()["pairing_code"]


def test_a_new_login_has_one_space_and_the_other_is_added_only_when_asked_for(app):
    c, h = family(app)
    assert me(c)["spaces"] == ["family"] and me(c)["account_type"] == "family"
    r = switch(c, h, "adult")                                  # a stray click: nothing is created
    assert r.status_code == 409
    assert c.get("/api/children").get_json()["children"] == []
    r = switch(c, h, "adult", enable=True)
    assert r.status_code == 200
    user = r.get_json()["user"]
    assert user["account_type"] == "adult" and user["spaces"] == ["family", "adult"]
    kids = c.get("/api/children").get_json()["children"]
    assert [(k["name"], k["kind"]) for k in kids] == [("Me", "self")]
    assert switch(c, h, "teal").status_code == 400
    assert switch(c, h, "adult", enable=True).status_code == 200      # enabling twice adds nothing more
    assert len(c.get("/api/children").get_json()["children"]) == 1


def test_an_adult_login_can_add_a_family_space(app):
    c, h = adult(app, "grownup@x.com")
    assert me(c)["spaces"] == ["adult"]
    assert c.post("/api/children", json={"name": "Mia"}, headers=h).status_code == 403   # the personal space has one profile
    assert switch(c, h, "family", enable=True).status_code == 200
    assert me(c)["account_type"] == "family" and me(c)["spaces"] == ["family", "adult"]
    assert c.get("/api/children").get_json()["children"] == []
    assert c.post("/api/children", json={"name": "Mia"}, headers=h).status_code == 201


def test_each_space_shows_only_its_own_profiles_rules_and_activity(app):
    c, h = family(app)
    mia = c.post("/api/children", json={"name": "Mia"}, headers=h).get_json()["id"]
    switch(c, h, "adult", enable=True)
    names = lambda: [k["name"] for k in c.get("/api/children").get_json()["children"]]
    assert names() == ["Me"]
    adult_rules = [p["name"] for p in c.get("/api/policies").get_json()["policies"]]
    assert adult_rules == ["My protection"]
    assert c.get(f"/api/stats?child_id={mia}").status_code == 404           # a child of the other space is not in scope here
    switch(c, h, "family")
    assert names() == ["Mia"]
    assert "My protection" not in [p["name"] for p in c.get("/api/policies").get_json()["policies"]]
    assert c.get(f"/api/stats?child_id={mia}").status_code == 200


def test_rule_sets_cannot_cross_between_spaces(app):
    c, h = family(app)
    mia = c.post("/api/children", json={"name": "Mia"}, headers=h).get_json()["id"]
    assert c.post("/api/policies", json={"name": "x", "preset": "shield_strict"}, headers=h).status_code == 400   # personal preset, family space
    kid_rules = c.post("/api/policies", json={"name": "Kids", "preset": "teen"}, headers=h).get_json()["id"]
    switch(c, h, "adult", enable=True)
    assert c.post("/api/policies", json={"name": "x", "preset": "teen"}, headers=h).status_code == 400            # child preset, personal space
    mine = c.post("/api/policies", json={"name": "Strict", "preset": "shield_strict"}, headers=h)
    assert mine.status_code == 201
    me_id = c.get("/api/children").get_json()["children"][0]["id"]
    assert c.put(f"/api/children/{me_id}/policy", json={"policy_id": kid_rules}, headers=h).status_code == 404
    assert c.put(f"/api/children/{me_id}/policy", json={"policy_id": mine.get_json()["id"]}, headers=h).status_code == 200
    switch(c, h, "family")
    assert c.put(f"/api/children/{mia}/policy", json={"policy_id": mine.get_json()["id"]}, headers=h).status_code == 404


def test_the_space_you_were_in_is_remembered_at_the_next_sign_in(app):
    c, h = family(app, "remember@x.com")
    switch(c, h, "adult", enable=True)
    again = app.test_client()
    r = again.post("/api/auth/login", json={"email": "remember@x.com", "password": "password123"})
    assert r.get_json()["user"]["account_type"] == "adult"
    switch(again, {"X-CSRF-Token": r.get_json()["csrf"]}, "family")
    assert me(again)["account_type"] == "family"


def test_a_request_can_name_the_space_it_means_without_switching(app):
    c, h = family(app, "both2@x.com")
    mia = c.post("/api/children", json={"name": "Mia"}, headers=h).get_json()["id"]
    switch(c, h, "adult", enable=True)                                   # the saved choice is now the personal space
    names = lambda q: [k["name"] for k in c.get("/api/children" + q).get_json()["children"]]
    assert names("") == ["Me"]
    assert names("?space=family") == ["Mia"]                            # a tab (or a prefetch) that means the family space
    assert names("?space=adult") == ["Me"]
    assert c.get("/api/stats?space=family").status_code == 200
    assert c.get(f"/api/stats?child_id={mia}&space=family").status_code == 200
    assert c.get(f"/api/stats?child_id={mia}&space=adult").status_code == 404
    assert me(c)["account_type"] == "adult"                              # nothing was switched or saved
    assert c.get("/api/auth/me?space=family").get_json()["user"]["account_type"] == "family"
    assert [p["name"] for p in c.get("/api/policies?space=family").get_json()["policies"]] == []


def test_a_request_cannot_name_a_space_the_login_does_not_have(app):
    c, h = family(app, "one@x.com")
    c.post("/api/children", json={"name": "Mia"}, headers=h)
    assert [k["name"] for k in c.get("/api/children?space=adult").get_json()["children"]] == ["Mia"]
    assert [k["name"] for k in c.get("/api/children?space=nonsense").get_json()["children"]] == ["Mia"]
    assert me(c)["spaces"] == ["family"]                                 # asking never creates a space


def test_a_browser_becomes_the_version_of_the_profile_it_was_paired_to_even_on_one_login(app):
    c, h = family(app)
    mia = c.post("/api/children", json={"name": "Mia"}, headers=h).get_json()["id"]
    kid_code = code_for(c, h, mia)
    switch(c, h, "adult", enable=True)
    my_id = c.get("/api/children").get_json()["children"][0]["id"]
    my_code = code_for(c, h, my_id)

    kid = app.test_client().post("/api/devices/pair", json={"code": kid_code}).get_json()
    mine = app.test_client().post("/api/devices/pair", json={"code": my_code}).get_json()
    assert kid["mode"] == "family" and mine["mode"] == "adult"
    sync = lambda t: app.test_client().get("/api/ext/policy-sync", headers={"Authorization": f"Bearer {t['token']}"}).get_json()
    assert sync(kid)["mode"] == "family" and sync(mine)["mode"] == "adult"

    # leaving: your own browser just confirms, a child's browser still needs the parent's password
    leave = lambda t, body: app.test_client().post("/api/ext/disconnect", json=body, headers={"Authorization": f"Bearer {t['token']}"})
    assert leave(kid, {}).status_code == 403
    assert leave(kid, {"password": "password123"}).status_code == 200
    assert leave(mine, {}).status_code == 200
