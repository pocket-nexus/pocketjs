fn main() {
    use pocket_sim::Predictor;

    fn step(position: &mut i32, movement: &i32) {
        *position += movement;
    }
    let mut predicted = Predictor::<i32, i32, 8>::new(0, 0);
    predicted.predict(2, step).unwrap();
    predicted.predict(3, step).unwrap();
    assert_eq!(*predicted.state(), 5);
    // The server observed position 1 after tick 1; replay tick 2's movement.
    let correction = predicted.reconcile(1, 1, step).unwrap();
    assert!(correction.corrected);
    assert_eq!(correction.replayed, 1);
    assert_eq!(*predicted.state(), 4);
}
