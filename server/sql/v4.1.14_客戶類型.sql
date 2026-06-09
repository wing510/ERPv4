-- v4.1 step14：客戶類型（個人 / 公司）

alter table customer add column if not exists customer_type text default 'COMPANY';
comment on column customer.customer_type is 'PERSON=個人, COMPANY=公司（預設）';

update customer set customer_type = 'COMPANY' where customer_type is null or trim(customer_type) = '';
