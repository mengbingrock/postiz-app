from postiz_mcp.login import connect_url, parse_callback, web_origin


def test_web_origin_and_connect_url():
    assert web_origin("https://post.truegrit.dev/post/mcp") == "https://post.truegrit.dev"
    url = connect_url("https://post.truegrit.dev/post/mcp", "abc", 43210, "my-mac")
    assert url.startswith("https://post.truegrit.dev/mcp/connect?")
    assert "state=abc" in url and "port=43210" in url and "device=my-mac" in url


def test_parse_callback_requires_matching_state_and_key():
    ok = parse_callback("/callback?state=s1&key=k1", "s1")
    assert ok.api_key == "k1" and ok.error is None
    assert parse_callback("/callback?state=other&key=k1", "s1").error == "state mismatch"
    assert parse_callback("/callback?state=s1", "s1").error == "missing key"
    assert parse_callback("/elsewhere?state=s1&key=k1", "s1").error == "unexpected path"
