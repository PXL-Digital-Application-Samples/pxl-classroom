import unittest
from data_processor import clean_and_aggregate

class TestDataProcessor(unittest.TestCase):
    def test_basic_stats(self):
        """Test basic integer list calculation (10 pts)"""
        res = clean_and_aggregate([10, 20, 30, 40])
        self.assertEqual(res['count'], 4)
        self.assertEqual(res['sum'], 100.0)
        self.assertEqual(res['avg'], 25.0)
        self.assertEqual(res['sorted_values'], [10.0, 20.0, 30.0, 40.0])

    def test_edge_case_empty_null(self):
        """Test handling of None, empty list, and dirty records (10 pts)"""
        self.assertEqual(clean_and_aggregate([])['count'], 0)
        self.assertEqual(clean_and_aggregate(None)['sum'], 0.0)
        
        dirty = [None, 5, {'val': 15}, None, {'val': None}, 10]
        res = clean_and_aggregate(dirty)
        self.assertEqual(res['count'], 3)
        self.assertEqual(res['sum'], 30.0)
        self.assertEqual(res['avg'], 10.0)
        self.assertEqual(res['sorted_values'], [5.0, 10.0, 15.0])

    def test_scaling_and_sorting(self):
        """Test negative numbers, floats, and ordering (10 pts)"""
        res = clean_and_aggregate([100.5, -50.5, 0, 50.0])
        self.assertEqual(res['count'], 4)
        self.assertEqual(res['sum'], 100.0)
        self.assertEqual(res['avg'], 25.0)
        self.assertEqual(res['sorted_values'], [-50.5, 0.0, 50.0, 100.5])

if __name__ == '__main__':
    unittest.main()
