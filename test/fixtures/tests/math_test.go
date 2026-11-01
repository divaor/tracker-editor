package m

import "testing"

func TestAdd(t *testing.T) {
	if Add(1, 1) != 2 {
		t.Fatal("bad")
	}
}

func TestSub(t *testing.T) {
	if 3-1 != 1 {
		t.Errorf("3-1 = %d, want 1", 3-1)
	}
}

func TestTable(t *testing.T) {
	t.Run("one", func(t *testing.T) {})
	t.Run("two", func(t *testing.T) { t.Skip("later") })
}
