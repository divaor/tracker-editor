import unittest


class MathTest(unittest.TestCase):
    def test_adds(self):
        self.assertEqual(1 + 1, 2)

    def test_subtracts(self):
        self.assertEqual(3 - 1, 1)


if __name__ == "__main__":
    unittest.main()
