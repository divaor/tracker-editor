import pytest


def test_adds():
    assert 1 + 1 == 2


class TestMath:
    def test_subtracts(self):
        assert 3 - 1 == 1

    @pytest.mark.parametrize("n", [1, 2])
    def test_param(self, n):
        assert n > 0

    @pytest.mark.skip(reason="later")
    def test_later(self):
        pass
