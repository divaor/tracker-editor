pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds() {
        assert_eq!(add(1, 1), 2);
    }

    #[test]
    fn subtracts() {
        assert_eq!(3 - 1, 1, "three minus one");
    }

    #[test]
    #[ignore]
    fn later() {}
}
