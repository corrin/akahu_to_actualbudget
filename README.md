# akahu_to_actualbudget

This script (Node.js) downloads all your recent transactions using the Open Banking data aggregator Akahu, and posts them to Actual Budget.  If you live in NZ and use Actual Budget, then this should give you automatic transaction importing.
Akahu acts as an aggregator in NZ, providing data from all the major banks, and quite a few other financial institutions.  That way this script works as `^(Westpac|Kiwibank|BNZ|ANZ|Simplicity|IRD|ASB)+$` to Actual Budget.

I wrote it for myself and there's bound to be a couple assumptions I made that are me-specific, so please let me know if you spot any.  

You'll need to sign up for a developer account at Akahu (https://my.akahu.nz/apps).  If there's enough interest then I can convert what I've written to use OAuth rather than secret keys.

I'm sure you could tweak this if you had different goals.  My first incantation mapped Akahu to YNAB.
