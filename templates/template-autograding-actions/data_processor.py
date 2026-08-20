"""
PXL Classroom - Group Data Processor Starter
Team implementation file for group-autograding-actions assignment.
"""

def clean_and_aggregate(records):
    """
    Cleans a list of numerical or dict records, removes None/nulls, and computes aggregate statistics.
    Returns: { 'count': int, 'sum': float, 'avg': float, 'sorted_values': list }
    """
    if records is None or len(records) == 0:
        return {'count': 0, 'sum': 0.0, 'avg': 0.0, 'sorted_values': []}

    valid_numbers = []
    for item in records:
        if item is None:
            continue
        if isinstance(item, (int, float)):
            valid_numbers.append(float(item))
        elif isinstance(item, dict) and 'val' in item and item['val'] is not None:
            valid_numbers.append(float(item['val']))

    if not valid_numbers:
        return {'count': 0, 'sum': 0.0, 'avg': 0.0, 'sorted_values': []}

    total = sum(valid_numbers)
    count = len(valid_numbers)
    avg = total / count
    sorted_vals = sorted(valid_numbers)

    return {
        'count': count,
        'sum': total,
        'avg': avg,
        'sorted_values': sorted_vals,
    }
